import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthoredFlowExecutionError } from '../src/authored-flow-error.js';
import { resumeFlow } from '../src/cli/run.js';
import { socketPathFor } from '../src/daemon-connection.js';
import * as daemonLifecycle from '../src/daemon-lifecycle.js';
import { JournalClient } from '../src/journal-client.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';

const RUN_ID = '01M2NDS2RYK3MH6YBSB1CHA9SE';
const EVIDENCE = `Run "${RUN_ID}" failed with completionReason: step_failed.`
  + ' Step "agent-2" (agent) completionReason: worker_error exit=1.'
  + '\nStderr (captured excerpt):\nclaude: permission denied: /work/out'
  + `\nInspect: flows replay ${RUN_ID} --at agent-2`;

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A data dir whose daemon answers, with the resume call itself scripted.
 *
 * The error is injected at `run.resume` rather than at
 * `resumeDurableAuthoredFlow`, because the unit under test is `resumeFlow`'s
 * catch and the classification it performs — and that catch inspects only the
 * error, never where in the try block it came from. Injecting here also keeps
 * the test off module mocking: `vi.mock` of authored-root.js does not reach
 * run.ts's own import of it, so a mocked `readAuthoredRootMetadata` is silently
 * bypassed (the real one swallows its failure and returns undefined), and the
 * test passes through a path it never meant to exercise. An empty
 * `journal.read` gives the same undefined deterministically instead.
 */
function daemonRejectingResume(error: Error): string {
  const dir = mkdtempSync(join(tmpdir(), 'flows-resume-'));
  directories.push(dir);
  vi.spyOn(daemonLifecycle, 'ensureDaemon').mockResolvedValue({
    kind: 'attached', socketPath: socketPathFor(dir), connection: null,
  });
  vi.spyOn(JournalClient.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(JournalClient.prototype, 'hello').mockResolvedValue({
    protocol: PROTOCOL_VERSION, server: 'relayflowd-test',
  });
  vi.spyOn(JournalClient.prototype, 'close').mockReturnValue(undefined);
  // No authored root entry, so `readAuthoredRootMetadata` resolves undefined.
  vi.spyOn(JournalClient.prototype, 'journalRead').mockResolvedValue({ entries: [] });
  vi.spyOn(JournalClient.prototype, 'runResume').mockRejectedValue(error);
  return dir;
}

// `runDirectFlow` was covered by a test and `resumeFlow` was not, which is
// exactly how the resume path kept the old misclassification through a review
// of the change that fixed the run path (Bugbot on #430,
// BUGBOT_BUG_ID 93b20728-614e-4055-b42c-0c996ad4f983). Both paths now go
// through `authoredStepFailure`, and both are pinned.
it('reports an authored resume step failure as step_failed, not protocol_error', async () => {
  const dir = daemonRejectingResume(
    new AuthoredFlowExecutionError('step_failed', EVIDENCE, undefined, RUN_ID),
  );

  const result = await resumeFlow(RUN_ID, dir, {});

  expect(result.exitCode).toBe(1);
  // A report with no status is precisely what printed `RUN <id> unknown`.
  expect(result.report.status).toBe('failed');
  expect(result.report.completionReason).toBe('step_failed');
  expect(result.report.rootRunId).toBe(RUN_ID);
  const kinds = result.report.diagnostics.map(diagnostic => diagnostic.kind);
  expect(kinds).toContain('step_failed');
  expect(kinds).not.toContain('protocol_error');
  expect(JSON.stringify(result.report)).not.toContain('could not complete the resume request');
  // The evidence and the replay hint have to survive the hand-off, or resume
  // is classified correctly and still says nothing useful.
  expect(JSON.stringify(result.report)).toContain('permission denied');
  expect(JSON.stringify(result.report)).toContain('flows replay');
  // The `step_failed: ` prefix is redundant once the label carries it.
  expect(result.report.diagnostics.at(-1)?.message.startsWith('step_failed:')).toBe(false);
});

// The negative half: `protocol_error` still means what it says. A resume that
// genuinely could not establish an outcome must not be relabelled a step
// failure, and must not claim a status it does not have.
it('still reports a genuine transport failure on resume as protocol_error', async () => {
  const dir = daemonRejectingResume(new Error('connection closed'));

  const result = await resumeFlow(RUN_ID, dir, {});

  expect(result.exitCode).toBe(1);
  expect(result.report.diagnostics.map(diagnostic => diagnostic.kind)).toContain('protocol_error');
  expect(result.report.status).toBeUndefined();
});
