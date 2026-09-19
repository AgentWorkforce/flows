// Review finding on flows#495: the artifact exclusion must not depend on a
// value the close path may drop.
//
// The transcript file was excluded from the workspace diff via
// `result.transcript.file.path`, an OPTIONAL pointer that `finish` omits when
// `writer.close()` outruns TAIL_CLOSE_TIMEOUT_MS (and that `discardTranscript`
// omits on abort). The file is created before close and is still on disk, so a
// slow close made the runtime's own transcript a journaled agent artifact —
// precisely the leak the exclusion exists to prevent, on the one path where
// the exclusion silently stopped applying.
//
// The transcript writer is built inside `runAgentCli`, so the stall is injected
// by mocking the module it is built from. The stub still creates the real file
// at the real path: the leak needs the file to exist.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/agent-transcript.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent-transcript.js')>();
  return {
    ...actual,
    openTranscriptWriter: async (path: string) => {
      // Real path, real file — only the close is pathological.
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{"type":"system"}\n');
      return {
        write: () => {},
        close: () => new Promise<never>(() => {}),
      };
    },
  };
});

vi.mock('../src/transcript-tail.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/transcript-tail.js')>();
  // Short, so the deadline is crossed in a test rather than in two seconds.
  return { ...actual, TAIL_CLOSE_TIMEOUT_MS: 150 };
});

const { runAgentCli } = await import('../src/worker-cli.js');
const { transcriptPath } = await import('../src/agent-transcript.js');

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function dir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'transcript-exclusion-'));
  directories.push(directory);
  return directory;
}

describe('a transcript close that outruns its deadline', () => {
  it('still keeps the transcript out of the agent\'s artifacts', async () => {
    const workspace = dir();
    // Under the workspace and not a dotdir, so the walk reaches it.
    const dataDir = join(workspace, 'data');
    const identity = { dataDir, runId: 'run-9', stepId: 'analyze', attempt: 1 };
    const cli = join(workspace, 'claude');
    writeFileSync(cli, "#!/usr/bin/env node\nrequire('node:fs').writeFileSync('report.md', 'real\\n');\nprocess.stdout.write('done');\n", { mode: 0o755 });

    const started = Date.now();
    const result = await runAgentCli(cli, 'go', undefined, 'unpriced-test-model', undefined, undefined, 'agent', {
      ...identity, onDrive() {},
    }, workspace);

    expect(result.exit_code).toBe(0);
    // The deadline was crossed: the step settled without waiting on the close,
    // and therefore without the pointer the old exclusion read.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.transcript?.file).toBeUndefined();
    // The file is nonetheless on disk, inside the scanned tree.
    expect(existsSync(transcriptPath(identity, 1))).toBe(true);
    // ...and is not the agent's work.
    expect(result.artifacts).toEqual(['report.md']);
  }, 30_000);
});
