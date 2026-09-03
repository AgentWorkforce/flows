import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JournalClient } from '../src/journal-client.js';
import type { Pins } from '../src/protocol.js';
import { AgentWorker } from '../src/worker.js';
import { runAgentCli } from '../src/worker-cli.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'flows-wrapper-'));
  directories.push(directory);
  return directory;
}

function makeWrapper(directory: string, name: string, source: string): string {
  const wrapper = join(directory, name);
  writeFileSync(wrapper, `#!/usr/bin/env node\n${source}`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

async function withEnvironment<T>(
  values: Record<string, string>,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    prior.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe('custom wrapper execution identity', () => {
  it('passes an explicit safe environment at identification and execution', async () => {
    const directory = makeDirectory();
    const wrapper = makeWrapper(directory, 'environment-wrapper', `
const secretNames = [
  'RELAYFLOW_MODEL',
  'RELAYFLOW_WAKE_CONTEXT',
  'RELAYFLOWS_TEST_SECRET',
  'AWS_SECRET_ACCESS_KEY',
  'GITHUB_TOKEN',
];
const snapshot = () => Object.fromEntries(secretNames.map(name => [name, process.env[name] ?? null]));
const identificationEnvironment = snapshot();
process.stdout.write('relayflows-agent-cli-v1\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  const executionEnvironment = snapshot();
  process.stdout.write(JSON.stringify({
    identificationEnvironment,
    executionEnvironment,
    pathPresent: typeof process.env.PATH === 'string' && process.env.PATH.length > 0,
    instruction: request.instruction,
    model: request.model,
    wakeContext: request.wakeContext,
  }));
});
`);

    const result = await withEnvironment({
      RELAYFLOW_MODEL: 'ambient-model',
      RELAYFLOW_WAKE_CONTEXT: 'ambient-wake',
      RELAYFLOWS_TEST_SECRET: 'private-test-secret',
      AWS_SECRET_ACCESS_KEY: 'private-aws-secret',
      GITHUB_TOKEN: 'private-github-token',
    }, () => runAgentCli(wrapper, 'private instruction', { private: 'wake' }, 'private-model'));

    expect(result).toMatchObject({ exit_code: 0, stderr_tail: '' });
    expect(JSON.parse(result.stdout_tail)).toEqual({
      identificationEnvironment: {
        RELAYFLOW_MODEL: null,
        RELAYFLOW_WAKE_CONTEXT: null,
        RELAYFLOWS_TEST_SECRET: null,
        AWS_SECRET_ACCESS_KEY: null,
        GITHUB_TOKEN: null,
      },
      executionEnvironment: {
        RELAYFLOW_MODEL: null,
        RELAYFLOW_WAKE_CONTEXT: null,
        RELAYFLOWS_TEST_SECRET: null,
        AWS_SECRET_ACCESS_KEY: null,
        GITHUB_TOKEN: null,
      },
      pathPresent: true,
      instruction: 'private instruction',
      model: 'private-model',
      wakeContext: { private: 'wake' },
    });
  });

  it('refuses a wrapper symlink retarget before delivering private values', async () => {
    const directory = makeDirectory();
    const declared = join(directory, 'declared-wrapper');
    const requestEvidence = join(directory, 'trusted-request-evidence.json');
    const replacementEvidence = join(directory, 'replacement-evidence.json');
    const replacement = makeWrapper(directory, 'replacement-wrapper', `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(replacementEvidence)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write('{"replacement":true}');
`);
    const trusted = makeWrapper(directory, 'trusted-wrapper', `
const fs = require('node:fs');
if (process.argv[2] !== '--relayflows-adapter-v1') process.exit(90);
process.stdout.cork();
process.stdout.write('relayflows-agent-cli-v1\\n');
const next = ${JSON.stringify(declared)} + '.next';
fs.symlinkSync(${JSON.stringify(replacement)}, next);
fs.renameSync(next, ${JSON.stringify(declared)});
process.stdout.uncork();
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  if (input.trim() !== '') {
    fs.writeFileSync(${JSON.stringify(requestEvidence)}, input);
    process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  }
});
`);
    symlinkSync(trusted, declared);

    const result = await runAgentCli(
      declared,
      'MUST_NOT_CROSS_RETARGET',
      { private: 'wake' },
      'private-model',
    );

    expect(result.exit_code).toBeNull();
    expect(result.stderr_tail).toMatch(/identity changed/i);
    expect(realpathSync(declared)).toBe(realpathSync(replacement));
    expect(existsSync(requestEvidence)).toBe(false);
    expect(existsSync(replacementEvidence)).toBe(false);
  });

  it('bounds wrapper execution after acknowledgement', async () => {
    const directory = makeDirectory();
    const wrapper = makeWrapper(directory, 'slow-wrapper', `
process.stdout.write('relayflows-agent-cli-v1\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  setTimeout(() => process.exit(0), 250);
});
`);

    const result = await runAgentCli(wrapper, 'instruction', undefined, undefined, {
      executionTimeoutMs: 50,
    });

    expect(result.exit_code).toBeNull();
    expect(result.stderr_tail).toMatch(/timed out after 50ms/i);
  });

  it('bounds captured wrapper output', async () => {
    const directory = makeDirectory();
    const wrapper = makeWrapper(directory, 'noisy-wrapper', `
process.stdout.write('relayflows-agent-cli-v1\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  process.stdout.write('x'.repeat(80));
  process.stderr.write('y'.repeat(80));
});
`);

    const result = await runAgentCli(wrapper, 'instruction', undefined, undefined, {
      maxOutputBytes: 128,
    });

    expect(result.exit_code).toBeNull();
    expect(result.stderr_tail).toMatch(/output limit of 128 bytes/i);
  });

  it('refuses a duplicate execute protocol frame', async () => {
    const directory = makeDirectory();
    const wrapper = makeWrapper(directory, 'duplicate-frame-wrapper', `
process.stdout.write('relayflows-agent-cli-v1\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  process.stdout.write('{"mustNotBeAccepted":true}');
});
`);

    const result = await runAgentCli(wrapper, 'instruction', undefined);

    expect(result.exit_code).toBeNull();
    expect(result.stdout_tail).toBe('');
    expect(result.stderr_tail).toMatch(/duplicate execute protocol frame/i);
  });
});

/**
 * P1-1 and P1-2 from ops/reviews/20260903-pr136-signoff2-adversarial.md.
 *
 * Both findings share one shape: the reader hands control of a bound to the
 * thing it is bounding. These tests pin the reader as the owner of both
 * bounds, so a wrapper cannot defeat them by withholding an event or by
 * flushing its result in one write.
 */
describe('custom wrapper execution bounds are reader-owned', () => {
  /**
   * A wrapper that leaks a stdio pipe to a background helper. The wrapper
   * itself exits, but `child.once('close')` never fires because a descendant
   * still holds the inherited pipe. This is the case the existing
   * "bounds wrapper execution after acknowledgement" test does NOT cover:
   * there the wrapper is still alive when the deadline fires, so SIGTERM
   * closes its own pipes and 'close' arrives. That test proves the timer
   * FIRES. This one proves the bound HOLDS.
   */
  function leakyWrapperSource(inherit: 'inherit' | ['ignore', 'inherit', 'ignore'], holdMs: number): string {
    return `
const { spawn } = require('node:child_process');
process.stdout.write('relayflows-agent-cli-v1\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  process.stdout.write('{"ok":true}\\n');
  const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${holdMs})'], {
    stdio: ${JSON.stringify(inherit)},
    detached: true,
  });
  helper.unref();
  process.exit(0);
});
`;
  }

  it('resolves when a conforming wrapper leaks a stdio pipe to a background helper', async () => {
    const directory = makeDirectory();
    const wrapper = makeWrapper(directory, 'leaky-wrapper', leakyWrapperSource('inherit', 6_000));

    const started = Date.now();
    const result = await runAgentCli(wrapper, 'instruction', undefined, undefined, {
      handshakeTimeoutMs: 2_000,
      executionTimeoutMs: 300,
      maxOutputBytes: 100_000,
    });
    const elapsed = Date.now() - started;

    expect(result.exit_code).toBeNull();
    expect(result.stderr_tail).toMatch(/timed out after 300ms/i);
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);

  it('resolves when the leaked helper inherits stderr only', async () => {
    const directory = makeDirectory();
    const wrapper = makeWrapper(
      directory,
      'leaky-stderr-wrapper',
      leakyWrapperSource(['ignore', 'inherit', 'ignore'], 6_000),
    );

    const started = Date.now();
    const result = await runAgentCli(wrapper, 'instruction', undefined, undefined, {
      handshakeTimeoutMs: 2_000,
      executionTimeoutMs: 300,
      maxOutputBytes: 100_000,
    });
    const elapsed = Date.now() - started;

    expect(result.exit_code).toBeNull();
    expect(result.stderr_tail).toMatch(/timed out after 300ms/i);
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);

  it('resolves when a wrapper leaks a stdio pipe and exits before identifying', async () => {
    const directory = makeDirectory();
    const wrapper = makeWrapper(directory, 'leaky-silent-wrapper', `
const { spawn } = require('node:child_process');
const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], {
  stdio: 'inherit',
  detached: true,
});
helper.unref();
process.exit(0);
`);

    const started = Date.now();
    const result = await runAgentCli(wrapper, 'instruction', undefined, undefined, {
      handshakeTimeoutMs: 2_000,
      executionTimeoutMs: 5_000,
      maxOutputBytes: 100_000,
    });
    const elapsed = Date.now() - started;

    expect(result.exit_code).toBeNull();
    expect(result.stderr_tail).toMatch(/did not identify as relayflows-agent-cli-v1 within 2000ms/i);
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);

  /**
   * The product boundary, at DEFAULT limits — the only bounds an author can
   * actually reach, since `worker.ts` passes no `wrapperLimits`. A wrapper
   * that leaks a stdio pipe and never identifies must still complete the
   * step with a `completionReason` at the 10s default handshake bound, and
   * `close()` must drain. Before the fix the leaked helper (30s) owns the
   * clock, so this resolves at ~30s instead of ~11s.
   */
  it('journals a completionReason at the default bound when a wrapper leaks a stdio pipe', async () => {
    const directory = makeDirectory();
    const wrapper = makeWrapper(directory, 'leaky-step-wrapper', `
const { spawn } = require('node:child_process');
const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
  stdio: 'inherit',
  detached: true,
});
helper.unref();
process.exit(0);
`);

    const completions: unknown[][] = [];
    const client = new EventEmitter() as EventEmitter & Record<string, unknown>;
    client.workerAttach = async (): Promise<unknown> => ({ ok: true });
    client.stepComplete = async (...args: unknown[]): Promise<unknown> => {
      completions.push(args);
      return { ok: true };
    };

    const worker = new AgentWorker(client as unknown as JournalClient, {
      workerId: 'w-leak',
      pins: {} as Pins,
    });
    const workerErrors: unknown[] = [];
    worker.on('error', (error: unknown) => { workerErrors.push(error); });
    await worker.attach();

    client.emit('step.dispatch', {
      run_id: 'run-leak',
      step_id: 'step-leak',
      attempt: 1,
      step_type: 'agent',
      spec: { cli: wrapper, instruction: 'instruction' },
      lease_id: 'lease-leak',
      idempotency_key: 'idem-leak',
      pins: {} as Pins,
    });

    const started = Date.now();
    await worker.close();
    const elapsed = Date.now() - started;

    expect(workerErrors).toEqual([]);
    expect(completions).toHaveLength(1);
    // Argument 5 is `completionReason` in JournalClient.stepComplete.
    expect(completions[0]?.[4]).toBe('worker_error');
    expect(elapsed).toBeLessThan(20_000);
  }, 90_000);

  it('accepts an execute token and an over-8KiB payload flushed in one write', async () => {
    const directory = makeDirectory();
    const payload = JSON.stringify({ summary: 'r'.repeat(20_000) });
    const wrapper = makeWrapper(directory, 'coalesced-payload-wrapper', `
process.stdout.write('relayflows-agent-cli-v1\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('relayflows-agent-cli-v1-execute\\n' + ${JSON.stringify(payload)});
});
`);

    const result = await runAgentCli(wrapper, 'instruction', undefined, undefined, {
      handshakeTimeoutMs: 3_000,
      executionTimeoutMs: 5_000,
      maxOutputBytes: 1_048_576,
    });

    expect(result.stderr_tail).toBe('');
    expect(result.exit_code).toBe(0);
    expect(result.stdout_tail).toBe(payload);
  }, 20_000);

  it('accepts the same over-8KiB payload whether or not it coalesces with the execute token', async () => {
    const directory = makeDirectory();
    const payload = JSON.stringify({ summary: 'r'.repeat(20_000) });
    const makeVariant = (name: string, body: string): string => makeWrapper(directory, name, `
process.stdout.write('relayflows-agent-cli-v1\\n');
process.stdin.resume();
process.stdin.on('end', () => {
${body}
});
`);
    const coalesced = makeVariant('variant-coalesced-wrapper', `
  process.stdout.write('relayflows-agent-cli-v1-execute\\n' + ${JSON.stringify(payload)});
`);
    const sameTick = makeVariant('variant-same-tick-wrapper', `
  process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  process.stdout.write(${JSON.stringify(payload)});
`);
    const delayed = makeVariant('variant-delayed-wrapper', `
  process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  setTimeout(() => process.stdout.write(${JSON.stringify(payload)}), 50);
`);

    const limits = {
      handshakeTimeoutMs: 3_000,
      executionTimeoutMs: 5_000,
      maxOutputBytes: 1_048_576,
    };
    const results = await Promise.all([
      runAgentCli(coalesced, 'instruction', undefined, undefined, limits),
      runAgentCli(sameTick, 'instruction', undefined, undefined, limits),
      runAgentCli(delayed, 'instruction', undefined, undefined, limits),
    ]);

    for (const result of results) {
      expect(result.stderr_tail).toBe('');
      expect(result.exit_code).toBe(0);
      expect(result.stdout_tail).toBe(payload);
    }
    expect(results[0]?.stdout_tail).toBe(results[2]?.stdout_tail);
    expect(results[1]?.stdout_tail).toBe(results[2]?.stdout_tail);
  }, 30_000);

  it('still bounds an un-terminated handshake buffer and names the bound', async () => {
    const directory = makeDirectory();
    const wrapper = makeWrapper(directory, 'handshake-flood-wrapper', `
process.stdout.write('z'.repeat(64 * 1024));
setTimeout(() => {}, 5000);
`);

    const result = await runAgentCli(wrapper, 'instruction', undefined, undefined, {
      handshakeTimeoutMs: 3_000,
      executionTimeoutMs: 5_000,
      maxOutputBytes: 1_048_576,
    });

    expect(result.exit_code).toBeNull();
    expect(result.stderr_tail).toMatch(/handshake limit of 8192 bytes/i);
  }, 20_000);
});
