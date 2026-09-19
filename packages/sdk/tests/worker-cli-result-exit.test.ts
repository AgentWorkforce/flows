import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { RESULT_EXIT_GRACE_MS, runAgentCli } from '../src/worker-cli.js';

/**
 * Claude Code in print mode reports its final result and then waits for every
 * background task it started. A task that never ends kept a finished agent
 * step running until the run's deadline. These fakes stand in for that
 * `claude`: they stream a result and then never exit.
 */
const SDK = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILT_WORKER_CLI = join(SDK, 'dist', 'worker-cli.js');
const directories: string[] = [];

// Once, at the end: the concurrent cases below would otherwise remove each
// other's directories out from under a still-running fake.
// A failed assertion must not leave a fake running, so kill what survives.
afterAll(() => {
  for (const directory of directories.splice(0)) {
    for (const file of ['claude-pid', 'task-pid']) {
      try { process.kill(Number(readFileSync(join(directory, file), 'utf8')), 'SIGKILL'); } catch { /* gone */ }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'flows-result-exit-'));
  directories.push(directory);
  return directory;
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/**
 * A fake `claude` in `root/bin`. It records its pid, optionally starts a
 * background task in a process group of its own (as Claude's
 * `run_in_background` Bash does), streams `frames` — the last one split across
 * two writes, mid multi-byte character — and then runs `tail`.
 */
function fakeClaude(root: string, frames: unknown[], tail: string, backgroundTask = false): {
  claude: string; workspace: string; claudePid: string; taskPid: string;
} {
  const bin = join(root, 'bin');
  const workspace = join(root, 'workspace');
  mkdirSync(bin);
  mkdirSync(workspace);
  const claude = join(bin, 'claude');
  const claudePid = join(root, 'claude-pid');
  const taskPid = join(root, 'task-pid');
  const task = `require('node:fs').writeFileSync(${JSON.stringify(taskPid)}, String(process.pid)); setInterval(() => {}, 1000);`;
  writeFileSync(claude, `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
writeFileSync(${JSON.stringify(claudePid)}, String(process.pid));
${backgroundTask ? `spawn(process.execPath, ['-e', ${JSON.stringify(task)}], { detached: true, stdio: 'ignore' });` : ''}
const lines = ${JSON.stringify(frames)}.map(frame => JSON.stringify(frame) + '\\n');
const last = Buffer.from(lines.pop());
process.stdout.write(lines.join(''));
const cut = last.indexOf(Buffer.from('é')) + 1;
process.stdout.write(last.subarray(0, cut));
setTimeout(() => {
  process.stdout.write(last.subarray(cut));
  ${tail}
}, 50);
`);
  chmodSync(claude, 0o755);
  return { claude, workspace, claudePid, taskPid };
}

const usage = { input_tokens: 7, output_tokens: 3 };
const init = { type: 'system', subtype: 'init', session_id: 's' };
const assistant = { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } };
const hang = 'setInterval(() => {}, 1000);';

describe('a Claude agent step completes on its result, not only on process exit', () => {
  it.concurrent('settles a hung, successful run within the grace and stops its whole tree', async () => {
    const root = makeDirectory();
    const fake = fakeClaude(root, [init, assistant,
      { type: 'result', subtype: 'success', is_error: false, result: 'Done. Committed as 37d4294 — café', usage }],
    hang, true);
    const controller = new AbortController();
    const started = Date.now();
    const result = await runAgentCli(fake.claude, 'implement', undefined, undefined, undefined,
      controller.signal, 'agent', undefined, fake.workspace);
    const elapsed = Date.now() - started;

    expect(result).toMatchObject({ exit_code: 0, stdout_tail: 'Done. Committed as 37d4294 — café',
      tokens_input: 7, tokens_output: 3 });
    expect(result.stderr_tail).toContain('reported its final result but had not exited');
    expect(elapsed).toBeGreaterThanOrEqual(RESULT_EXIT_GRACE_MS);
    expect(elapsed).toBeLessThan(RESULT_EXIT_GRACE_MS + 5_000);
    await new Promise(settle => setTimeout(settle, 1_500));
    expect(alive(Number(readFileSync(fake.claudePid, 'utf8')))).toBe(false);
    expect(alive(Number(readFileSync(fake.taskPid, 'utf8')))).toBe(false);
  }, RESULT_EXIT_GRACE_MS + 15_000);

  it.concurrent('maps an error result on a hung run to a failed exit', async () => {
    const root = makeDirectory();
    const fake = fakeClaude(root, [init,
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'failed — é', usage }], hang);
    const result = await runAgentCli(fake.claude, 'implement', undefined, undefined, undefined,
      new AbortController().signal, 'agent', undefined, fake.workspace);

    expect(result).toMatchObject({ exit_code: 1, stdout_tail: 'failed — é' });
    await new Promise(settle => setTimeout(settle, 1_500));
    expect(alive(Number(readFileSync(fake.claudePid, 'utf8')))).toBe(false);
  }, RESULT_EXIT_GRACE_MS + 15_000);

  it.concurrent('leaves a hang before any result to the existing stops', async () => {
    const root = makeDirectory();
    const fake = fakeClaude(root, [init, assistant], hang);
    const controller = new AbortController();
    let settled = false;
    const running = runAgentCli(fake.claude, 'implement', undefined, undefined, undefined,
      controller.signal, 'agent', undefined, fake.workspace).finally(() => { settled = true; });
    await new Promise(settle => setTimeout(settle, RESULT_EXIT_GRACE_MS + 2_000));
    expect(settled).toBe(false);

    controller.abort(new Error('lease rejected'));
    const result = await running;
    expect(result.exit_code).toBeNull();
    expect(result.stderr_tail).toContain('Agent execution aborted: lease ownership lost.');
  }, RESULT_EXIT_GRACE_MS + 15_000);

  it('settles a normal exit at once with the real exit code', async () => {
    const root = makeDirectory();
    const fake = fakeClaude(root, [init,
      { type: 'result', subtype: 'success', is_error: false, result: 'ok é', usage }], 'process.exitCode = 0;');
    const started = Date.now();
    const result = await runAgentCli(fake.claude, 'implement', undefined, undefined, undefined,
      new AbortController().signal, 'agent', undefined, fake.workspace);

    expect(result).toMatchObject({ exit_code: 0, stdout_tail: 'ok é', stderr_tail: '' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('an agent tree does not outlive the process that spawned it', () => {
  it('kills the agent group when the run process is terminated by SIGTERM', async () => {
    expect(existsSync(BUILT_WORKER_CLI), `${BUILT_WORKER_CLI} is missing; run \`npm run build\``).toBe(true);
    const root = makeDirectory();
    const fake = fakeClaude(root, [init, assistant], hang);
    const harness = join(root, 'harness.mjs');
    writeFileSync(harness, `
import { runAgentCli } from ${JSON.stringify(BUILT_WORKER_CLI)};
await runAgentCli(${JSON.stringify(fake.claude)}, 'implement', undefined, undefined, undefined,
  new AbortController().signal, 'agent', undefined, ${JSON.stringify(fake.workspace)});
`);
    const run = spawn(process.execPath, [harness], { stdio: 'ignore' });
    const deadline = Date.now() + 5_000;
    while (!existsSync(fake.claudePid) && Date.now() < deadline) await new Promise(settle => setTimeout(settle, 20));
    const claudePid = Number(readFileSync(fake.claudePid, 'utf8'));
    expect(alive(claudePid)).toBe(true);

    // Past the fake's last write: a write into a dead pipe would kill it with
    // EPIPE, and the test would prove nothing about the reaper.
    await new Promise(settle => setTimeout(settle, 500));
    const exited = new Promise<NodeJS.Signals | null>(settle => run.once('exit', (_code, signal) => settle(signal)));
    run.kill('SIGTERM');
    expect(await exited).toBe('SIGTERM');
    await new Promise(settle => setTimeout(settle, 200));
    expect(alive(claudePid)).toBe(false);
  }, 15_000);
});
