import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { RESULT_EXIT_GRACE_MS, runAgentCli } from '../src/worker-cli.js';
import { GROUP_EXIT_CONFIRM_TIMEOUT_MS } from '../src/child-stop.js';

/**
 * Claude Code in print mode reports its final result and then waits for every
 * background task it started. A task that never ends kept a finished agent
 * step running until the run's deadline. These fakes stand in for that
 * `claude`: they stream a result and then never exit.
 */
const SDK = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILT_WORKER_CLI = join(SDK, 'dist', 'worker-cli.js');
const WRAPPER_HELPER = join(SDK, '..', '..', 'testdata', 'preflight', 'wrapper-session.mjs');
const directories: string[] = [];

function readPositivePid(path: string): number | undefined {
  const pid = Number(readFileSync(path, 'utf8'));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

// Once, at the end: the concurrent cases below would otherwise remove each
// other's directories out from under a still-running fake.
// A failed assertion must not leave a fake running, so kill what survives.
afterAll(() => {
  for (const directory of directories.splice(0)) {
    for (const file of ['claude-pid', 'task-pid', 'wrapper-pid']) {
      try {
        const pid = readPositivePid(join(directory, file));
        if (pid === undefined) continue;
        if (file === 'wrapper-pid') process.kill(-pid, 'SIGKILL');
        else process.kill(pid, 'SIGKILL');
      } catch { /* gone */ }
    }
    const aliasFile = join(directory, 'wrapper-alias');
    if (existsSync(aliasFile)) {
      const aliasDirectory = dirname(readFileSync(aliasFile, 'utf8'));
      if (dirname(aliasDirectory) === tmpdir() && basename(aliasDirectory).startsWith('relayflow-cli-')) {
        rmSync(aliasDirectory, { recursive: true, force: true });
      }
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
 * SIGTERM-deaf background task in a process group of its own (as Claude's
 * `run_in_background` Bash does), streams `frames` — the last one split across
 * two writes, mid multi-byte character — and then runs `tail`.
 */
function fakeClaude(root: string, frames: unknown[], tail: string, backgroundTask = false, aliasSensitive = false): {
  claude: string; workspace: string; claudePid: string; taskPid: string; aliasObserved: string; aliasPath: string;
} {
  const bin = join(root, 'bin');
  const workspace = join(root, 'workspace');
  mkdirSync(bin);
  mkdirSync(workspace);
  const claude = join(bin, aliasSensitive ? 'provider-cli.js' : 'claude');
  const claudePid = join(root, 'claude-pid');
  const taskPid = join(root, 'task-pid');
  const aliasObserved = join(root, 'alias-observed');
  const aliasPath = join(root, 'alias-path');
  // Deaf to SIGTERM, so only the escalation to SIGKILL can end it.
  const task = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(taskPid)}, String(process.pid)); setInterval(() => {}, 1000);`;
  writeFileSync(claude, `#!/usr/bin/env node
const { existsSync, writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
writeFileSync(${JSON.stringify(claudePid)}, String(process.pid));
${aliasSensitive ? `writeFileSync(${JSON.stringify(aliasPath)}, process.argv[1]);` : ''}
${aliasSensitive ? `process.on('SIGTERM', () => setTimeout(() => writeFileSync(${JSON.stringify(aliasObserved)}, String(existsSync(process.argv[1]))), 50));` : ''}
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
  return { claude, workspace, claudePid, taskPid, aliasObserved, aliasPath };
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
    hang, true, true);
    const controller = new AbortController();
    const started = Date.now();
    const result = await runAgentCli(fake.claude, 'implement', undefined, undefined, undefined,
      controller.signal, 'agent', undefined, fake.workspace, 'direct', undefined, process.env, 'claude');
    const elapsed = Date.now() - started;

    expect(result).toMatchObject({ exit_code: 0, stdout_tail: 'Done. Committed as 37d4294 — café',
      tokens_input: 7, tokens_output: 3 });
    expect(result.stderr_tail).toContain('reported its final result but had not exited');
    expect(elapsed).toBeGreaterThanOrEqual(RESULT_EXIT_GRACE_MS);
    expect(elapsed).toBeLessThan(RESULT_EXIT_GRACE_MS + 5_000);
    await new Promise(settle => setTimeout(settle, 1_500));
    expect(readFileSync(fake.aliasObserved, 'utf8')).toBe('true');
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
    const fake = fakeClaude(root, [init, assistant], hang, false, true);
    const harness = join(root, 'harness.mjs');
    writeFileSync(harness, `
import { runAgentCli } from ${JSON.stringify(BUILT_WORKER_CLI)};
await runAgentCli(${JSON.stringify(fake.claude)}, 'implement', undefined, undefined, undefined,
  new AbortController().signal, 'agent', undefined, ${JSON.stringify(fake.workspace)},
  'direct', undefined, process.env, 'claude');
`);
    const run = spawn(process.execPath, [harness], { stdio: 'ignore' });
    const deadline = Date.now() + 5_000;
    while ((!existsSync(fake.claudePid) || !existsSync(fake.aliasPath)) && Date.now() < deadline) {
      await new Promise(settle => setTimeout(settle, 20));
    }
    const claudePid = Number(readFileSync(fake.claudePid, 'utf8'));
    const aliasPath = readFileSync(fake.aliasPath, 'utf8');
    expect(alive(claudePid)).toBe(true);
    expect(existsSync(aliasPath)).toBe(true);

    // Past the fake's last write: a write into a dead pipe would kill it with
    // EPIPE, and the test would prove nothing about the reaper.
    await new Promise(settle => setTimeout(settle, 500));
    const exited = new Promise<NodeJS.Signals | null>(settle => run.once('exit', (_code, signal) => settle(signal)));
    run.kill('SIGTERM');
    expect(await exited).toBe('SIGTERM');
    await new Promise(settle => setTimeout(settle, 200));
    expect(alive(claudePid)).toBe(false);
    expect(existsSync(aliasPath)).toBe(false);
  }, 15_000);

  it('removes a wrapper alias on host exit after group death stays unprovable', async () => {
    expect(existsSync(BUILT_WORKER_CLI), `${BUILT_WORKER_CLI} is missing; run \`npm run build\``).toBe(true);
    const root = makeDirectory();
    const aliasFile = join(root, 'wrapper-alias');
    const resultFile = join(root, 'wrapper-result');
    const wrapperPid = join(root, 'wrapper-pid');
    const wrapper = join(root, 'provider-wrapper.mjs');
    writeFileSync(wrapper, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { receiveWrapperRequest } from ${JSON.stringify(WRAPPER_HELPER)};
writeFileSync(${JSON.stringify(wrapperPid)}, String(process.pid));
writeFileSync(${JSON.stringify(aliasFile)}, process.argv[1]);
await receiveWrapperRequest();
setInterval(() => {}, 1000);
`);
    chmodSync(wrapper, 0o755);
    const harness = join(root, 'wrapper-harness.mjs');
    writeFileSync(harness, `
import { existsSync, writeFileSync } from 'node:fs';
import { runAgentCli } from ${JSON.stringify(BUILT_WORKER_CLI)};
const actualKill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (typeof pid === 'number' && pid < 0 && signal === 0) {
    const error = new Error('not permitted');
    error.code = 'EPERM';
    throw error;
  }
  return actualKill(pid, signal);
};
const controller = new AbortController();
const running = runAgentCli(${JSON.stringify(wrapper)}, 'implement', undefined, undefined, undefined,
  controller.signal, 'agent', undefined, ${JSON.stringify(root)},
  'direct', undefined, process.env, 'wrapper.mjs');
const aliasDeadline = Date.now() + 5_000;
while (!existsSync(${JSON.stringify(aliasFile)}) && Date.now() < aliasDeadline) {
  await new Promise(wait => setTimeout(wait, 10));
}
if (!existsSync(${JSON.stringify(aliasFile)})) throw new Error('wrapper alias was not observed');
await new Promise(wait => setTimeout(wait, 250));
controller.abort(new Error('lease rejected'));
writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(await running));
`);
    const run = spawn(process.execPath, [harness], { stdio: 'ignore' });
    let alias: string | undefined;
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(aliasFile) && Date.now() < deadline) await new Promise(wait => setTimeout(wait, 20));
      expect(existsSync(aliasFile)).toBe(true);
      alias = readFileSync(aliasFile, 'utf8');
      expect(alias).toMatch(/relayflow-cli-/);
      expect(existsSync(alias)).toBe(true);
      const code = await new Promise<number | null>((resolveExit, rejectExit) => {
        const bound = setTimeout(() => {
          run.kill('SIGKILL');
          rejectExit(new Error('wrapper harness did not exit'));
        }, 10_000);
        run.once('error', rejectExit);
        run.once('exit', exitCode => { clearTimeout(bound); resolveExit(exitCode); });
      });
      expect(code).toBe(0);
      expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toMatchObject({
        exit_code: null,
        stderr_tail: expect.stringMatching(new RegExp(
          `did not stop answering within ${GROUP_EXIT_CONFIRM_TIMEOUT_MS}ms`,
          'i',
        )),
      });
      expect(existsSync(alias)).toBe(false);
    } finally {
      if (run.exitCode === null && run.signalCode === null) {
        const exited = new Promise<void>(resolveExit => run.once('exit', () => resolveExit()));
        run.kill('SIGKILL');
        await Promise.race([exited, new Promise<void>(resolveWait => setTimeout(resolveWait, 1_000))]);
      }
      if (existsSync(wrapperPid)) {
        const pid = readPositivePid(wrapperPid);
        if (pid !== undefined) {
          try { process.kill(-pid, 'SIGKILL'); } catch {
            try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
          }
        }
      }
      alias ??= existsSync(aliasFile) ? readFileSync(aliasFile, 'utf8') : undefined;
      if (alias !== undefined) {
        const aliasDirectory = dirname(alias);
        if (dirname(aliasDirectory) === tmpdir() && basename(aliasDirectory).startsWith('relayflow-cli-')) {
          rmSync(aliasDirectory, { recursive: true, force: true });
        }
      }
    }
  }, 15_000);

  it('ignores empty and partial wrapper PID records during cleanup', () => {
    const root = makeDirectory();
    const pidFile = join(root, 'wrapper-pid');
    for (const value of ['', '0', '-1', '12x']) {
      writeFileSync(pidFile, value);
      expect(readPositivePid(pidFile)).toBeUndefined();
    }
    writeFileSync(pidFile, '123');
    expect(readPositivePid(pidFile)).toBe(123);
  });
});
