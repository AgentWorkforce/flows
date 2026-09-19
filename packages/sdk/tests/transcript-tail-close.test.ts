// Review finding on flows#492: a stalled transcript-tail flush must not hold
// a spawn open. `finish` marks the invocation settled and only then awaited
// both closes, so a write that never returned left `runAgentCli` unresolved
// forever — and every later abort or timeout is a no-op once `settled`.
//
// The tail writers are built inside `runAgentCli`, so the stall is injected by
// mocking the module it builds them from.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const stalled: Array<{ closeCalled: boolean }> = [];

vi.mock('../src/transcript-tail.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/transcript-tail.js')>();
  return {
    ...actual,
    // A short window keeps the test quick; the production value is 2s.
    TAIL_CLOSE_TIMEOUT_MS: 150,
    openTranscriptTail: () => {
      const record = { closeCalled: false };
      stalled.push(record);
      return {
        append: () => {},
        // Never resolves: the filesystem call that hangs.
        close: () => { record.closeCalled = true; return new Promise<void>(() => {}); },
      };
    },
  };
});

const { runAgentCli } = await import('../src/worker-cli.js');

const directories: string[] = [];
afterEach(() => {
  stalled.splice(0);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function dir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tail-close-'));
  directories.push(directory);
  return directory;
}

describe('a stalled transcript-tail close', () => {
  it('does not hold the spawn open past its bounded window', async () => {
    const dataDir = dir();
    const cli = join(dataDir, 'claude');
    writeFileSync(cli, "#!/usr/bin/env node\nprocess.stdout.write('done');\n", { mode: 0o755 });
    const started = Date.now();
    const result = await runAgentCli(cli, 'go', undefined, 'unpriced-test-model', undefined, undefined, 'agent', {
      dataDir, runId: 'run-9', stepId: 'analyze', attempt: 1, onDrive() {},
    });
    // Settles on the deadline rather than on a close that never comes.
    expect(result).toMatchObject({ exit_code: 0, stdout_tail: 'done' });
    expect(Date.now() - started).toBeLessThan(5_000);
    // Both closes were attempted and are still outstanding — best effort, not
    // abandoned: the step simply stopped waiting on them.
    expect(stalled.map((tail) => tail.closeCalled)).toEqual([true, true]);
  }, 20_000);
});

describe('a stalled tail close beside a transcript that finished', () => {
  it('still journals the transcript pointer', async () => {
    // The two closes are independent. Coupling them through one `Promise.all`
    // threw away a transcript that was finished and on disk because a tail
    // had not returned.
    const dataDir = dir();
    const cli = join(dataDir, 'claude');
    writeFileSync(cli, "#!/usr/bin/env node\nprocess.stdout.write('done');\n", { mode: 0o755 });
    const result = await runAgentCli(cli, 'go', undefined, 'unpriced-test-model', undefined, undefined, 'agent', {
      dataDir, runId: 'run-9', stepId: 'analyze', attempt: 1, onDrive() {},
    });
    expect(result.exit_code).toBe(0);
    // The tails never closed (they are the stalled mock), but the transcript
    // writer is real and its descriptor survived the deadline.
    expect(stalled.map((tail) => tail.closeCalled)).toEqual([true, true]);
    expect(result.transcript?.file?.path).toContain('attempt-1.transcript.jsonl');
    expect(existsSync(result.transcript!.file!.path)).toBe(true);
  }, 20_000);
});
