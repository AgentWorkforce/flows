import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { childStop } from '../src/child-stop.js';

/**
 * A stop that settles the step Promise is not a stop that lets `flows run`
 * exit. `'close'` waits on every inherited stdio pipe, and a grandchild that
 * survived the stop holds one forever — the run's own event loop stays
 * referenced by that pipe handle long after the step has been journaled.
 *
 * So these assert on PROCESS EXIT, not on a resolved Promise: a real node
 * process drives the built SDK to a stop and then has to die on its own. The
 * step-settles side is already covered in `worker-cli.test.ts`; what is proved
 * here is the reach of the stop, across every path that has one. Abort is
 * covered by `worker-cli-abort.test.ts`; the two wrapper stops are covered
 * end-to-end below; the raw-CLI timeout call site, which `agentExecution`
 * currently pins to `timeoutMs: 0` and so cannot be reached through
 * `runAgentCli`, is covered at the shared helper it now delegates to.
 */
const SDK = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILT_WORKER_CLI = join(SDK, 'dist', 'worker-cli.js');
const WRAPPER_HELPER = resolve(SDK, '..', '..', 'testdata', 'preflight', 'wrapper-session.mjs');
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'flows-stop-group-'));
  directories.push(directory);
  return directory;
}

/**
 * A conforming wrapper that leaves a grandchild behind holding the stdio it
 * inherited, then does whatever `tail` asks for to trigger a stop.
 */
function writeLeakyWrapper(directory: string, name: string, tail: string): {
  wrapper: string;
  wrapperPid: string;
  grandchildPid: string;
} {
  const wrapper = join(directory, name);
  const wrapperPid = join(directory, `${name}.wrapper-pid`);
  const grandchildPid = join(directory, `${name}.grandchild-pid`);
  const grandchildSource = `require('node:fs').writeFileSync(${JSON.stringify(grandchildPid)}, String(process.pid)); setInterval(() => {}, 1000);`;
  writeFileSync(wrapper, `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { receiveWrapperRequest } from ${JSON.stringify(WRAPPER_HELPER)};
await receiveWrapperRequest();
writeFileSync(${JSON.stringify(wrapperPid)}, String(process.pid));
spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { stdio: 'inherit' });
// Block until the grandchild has announced itself, so a stop that arrives on
// the very next line still has a pid on disk to be judged against. A sync wait
// is the point: the wrapper's own loop must not advance past this.
const idle = new Int32Array(new SharedArrayBuffer(4));
for (let waited = 0; waited < 5_000 && !existsSync(${JSON.stringify(grandchildPid)}); waited += 10) {
  Atomics.wait(idle, 0, 0, 10);
}
${tail}
`);
  chmodSync(wrapper, 0o755);
  return { wrapper, wrapperPid, grandchildPid };
}

/**
 * Drive one wrapper session to a stop inside a real node process, exactly the
 * way `flows run` does, and report how long that process took to exit. Nothing
 * calls `process.exit()`: the harness ends only when its own event loop drains.
 */
async function runUntilExit(
  directory: string,
  wrapper: string,
  executionTimeoutMs: number,
): Promise<{ exitedWithinMs: number; code: number | null; stderrTail: string }> {
  expect(
    existsSync(BUILT_WORKER_CLI),
    `${BUILT_WORKER_CLI} is missing; run \`npm run build\` (\`npm test\` does) before this test`,
  ).toBe(true);
  const harness = join(directory, 'harness.mjs');
  writeFileSync(harness, `
import { runAgentCli } from ${JSON.stringify(BUILT_WORKER_CLI)};
// A never-aborted signal is what a lease-bound run holds for its whole life;
// it is also what asks the spawn for a process group of its own.
const controller = new AbortController();
const result = await runAgentCli(
  ${JSON.stringify(wrapper)},
  'instruction',
  undefined,
  undefined,
  { handshakeTimeoutMs: 5_000, executionTimeoutMs: ${executionTimeoutMs}, maxOutputBytes: 100_000 },
  controller.signal,
);
process.stdout.write(JSON.stringify({ stderr_tail: result.stderr_tail }) + '\\n');
`);
  const started = Date.now();
  const child = spawn(process.execPath, [harness], { stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    const bound = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExit(new Error('the run process never exited after the stop'));
    }, 15_000);
    child.once('error', rejectExit);
    child.once('exit', exitCode => { clearTimeout(bound); resolveExit(exitCode); });
  });
  const settled: unknown = JSON.parse(stdout.trim() === '' ? '{}' : stdout.trim());
  return {
    exitedWithinMs: Date.now() - started,
    code,
    stderrTail: String((settled as { stderr_tail?: unknown }).stderr_tail ?? ''),
  };
}

async function expectReaped(pidFile: string): Promise<void> {
  expect(existsSync(pidFile)).toBe(true);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise(wait => setTimeout(wait, 25));
  }
  expect(() => process.kill(pid, 0)).toThrow();
}

describe('every stop reaches the process group, not just the direct child', () => {
  it('exits the run after an execution-timeout stop', async () => {
    const directory = makeDirectory();
    const leaky = writeLeakyWrapper(directory, 'timeout-wrapper.mjs', 'setInterval(() => {}, 1000);');

    const run = await runUntilExit(directory, leaky.wrapper, 400);

    expect(run.stderrTail).toMatch(/execution timed out after 400ms/i);
    expect(run.code).toBe(0);
    expect(run.exitedWithinMs).toBeLessThan(10_000);
    await expectReaped(leaky.wrapperPid);
    await expectReaped(leaky.grandchildPid);
  }, 40_000);

  it('exits the run after a protocol terminate stop', async () => {
    const directory = makeDirectory();
    const leaky = writeLeakyWrapper(
      directory,
      'protocol-wrapper.mjs',
      // A second execute frame is a protocol violation, so the session
      // terminates on the spot rather than on any clock.
      `process.stdout.write('relayflows-agent-cli-v1-execute\\n');\nsetInterval(() => {}, 1000);`,
    );

    const run = await runUntilExit(directory, leaky.wrapper, 30_000);

    expect(run.stderrTail).toMatch(/duplicate execute protocol frame/i);
    expect(run.code).toBe(0);
    expect(run.exitedWithinMs).toBeLessThan(10_000);
    await expectReaped(leaky.wrapperPid);
    await expectReaped(leaky.grandchildPid);
  }, 40_000);

  /**
   * The raw-CLI timeout call site in `worker-cli.ts` cannot be reached through
   * `runAgentCli` today — `agentExecution` pins agent invocations to
   * `timeoutMs: 0` — so its reach is asserted on the helper it now delegates
   * to, which is the same object the two wrapper stops above go through.
   */
  it('terminate() forces a group that outlives SIGTERM', async () => {
    const directory = makeDirectory();
    const grandchildPid = join(directory, 'grandchild-pid');
    const source = `
const { spawn } = require('node:child_process');
process.on('SIGTERM', () => {});
spawn(process.execPath, ['-e', ${JSON.stringify(`process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(grandchildPid)}, String(process.pid)); setInterval(() => {}, 1000);`)}], { stdio: 'inherit' });
setInterval(() => {}, 1000);
`;
    const child = spawn(process.execPath, ['-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const stop = childStop(child, true, 200);
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(grandchildPid) && Date.now() < deadline) {
        await new Promise(wait => setTimeout(wait, 10));
      }
      expect(existsSync(grandchildPid)).toBe(true);

      stop.terminate();
      await new Promise<void>(resolveClose => child.once('close', () => { resolveClose(); }));
      await expectReaped(grandchildPid);
    } finally {
      stop.kill();
    }
  }, 30_000);
});
