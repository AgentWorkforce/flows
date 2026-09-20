import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunDiagnostic, RunReport } from '../src/cli/run.js';
import { chainFixture } from './flow-chain-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

const REJECTION = "remote: GitLab: You cannot push commits for 'factory@example.com'";
const NOTHING_STAGED = 'nothing staged inside the declared scope';

/**
 * The reported failure, reproduced: the first attempt is refused by a hook and
 * the second dies because the first attempt already had its side effect. The
 * marker file is that side effect — without one, a retried command fails the
 * same way twice and the bug is invisible.
 */
function divergentCommand(marker: string): string {
  return `if [ -f ${marker} ]; then printf %s ${JSON.stringify(NOTHING_STAGED)} >&2; `
    + `else : > ${marker}; printf %s ${JSON.stringify(REJECTION)} >&2; fi; exit 1`;
}

describe('a retried step failing differently through the live kernel', () => {
  it('reports both attempts and says the evidence differs', async () => {
    const fixture = chainFixture();
    cleanup.push(() => fixture.close());
    let journal = await fixture.connect();
    const flowPath = join(fixture.root, 'retried.flow.yaml');
    writeFileSync(flowPath, `version: '0.1.0'
name: retried-commit
steps:
  - id: commit-and-push
    type: deterministic
    maxIterations: 2
    command: ${JSON.stringify(divergentCommand(join(fixture.root, 'already-pushed')))}
`);

    const result = fixture.invoke('run', flowPath, '--data-dir', fixture.data, '--json');
    expect(result.status, result.stderr + result.stdout).toBe(1);
    const report = JSON.parse(result.stdout) as RunReport;
    const diagnostic = report.diagnostics.at(-1) as RunDiagnostic;

    expect(diagnostic).toMatchObject({
      kind: 'step_failed', stepId: 'commit-and-push', stepType: 'deterministic',
      completionReason: 'retries_exhausted', attempt: 2, maxIterations: 2,
      // The scalars remain the terminal attempt's, as they always were.
      exitCode: 1, stderrTail: NOTHING_STAGED,
      attemptEvidence: 'differs',
    });
    expect(diagnostic.attempts).toMatchObject([
      { attempt: 1, disposition: 'retry', exitCode: 1, stderrTail: REJECTION },
      { attempt: 2, disposition: 'step_done', exitCode: 1, stderrTail: NOTHING_STAGED },
    ]);
    // The account of what actually went wrong is in the rendered message, not
    // only in a field a machine reader has to know to ask for.
    expect(diagnostic.message).toContain(REJECTION);
    expect(diagnostic.message).toContain('An earlier attempt may have had side effects.');

    // The kernel journals each attempt's own captured output. Nothing above is
    // reconstructed by the reader; it is read back here from the daemon that
    // wrote it, after the process that ran the command is gone.
    journal = await fixture.restart();
    const { entries } = await journal.journalRead(report.runId, 1, 100);
    const completions = (entries as Array<{
      entry_type: string; attempt?: number;
      payload?: { completionReason?: string; disposition?: string; output?: { stderr_tail?: string } };
    }>).filter(entry => entry.entry_type === 'step.completed');
    expect(completions.map(entry => [
      entry.attempt, entry.payload?.completionReason, entry.payload?.disposition,
      entry.payload?.output?.stderr_tail,
    ])).toEqual([
      [1, 'verification_failed', 'retry', REJECTION],
      [2, 'retries_exhausted', 'step_done', NOTHING_STAGED],
    ]);
  }, 60_000);
});
