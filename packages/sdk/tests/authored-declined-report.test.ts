import { afterEach, expect, it, vi } from 'vitest';
import { authoredCompletion, type RunReport } from '../src/cli/run.js';
import { getCloudFlowRun } from '../src/cloud-run.js';

afterEach(() => vi.restoreAllMocks());
const prior = { severity: 'warning', kind: 'connection_file_stale', message: 'Prior diagnostic' } as const;
const base: RunReport = { ok: false, command: 'run', resolutions: [], diagnostics: [prior] };
const result = { name: 'guard', completionReason: 'declined' as const, journalSteps: [{}, {}] };

it.each(['run', 'resume'] as const)('reports deliberate declination on %s with prior diagnostics', command => {
  const execution = authoredCompletion(command, { ...base, command }, '/sock', result, 'root');
  expect(execution).toEqual({ exitCode: 0, report: {
    ...base, command, socketPath: '/sock', runId: 'root', completedSteps: 2,
    ok: true, status: 'completed', completionReason: 'success',
    diagnostics: [prior, { severity: 'declined', kind: 'run_declined',
      message: 'Flow deliberately chose not to act on this input.' }],
  } });
});

it.each([
  ['completed', 'success', true],
  ['completed', 'declined', false],
  ['failed', 'success', false],
  ['cancelled', 'success', false],
] as const)('Cloud accepts status %s with kernel reason %s: %s', async (status, reason, accepted) => {
  const report = authoredCompletion('run', base, '/sock', result, 'root').report;
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    runId: 'root', relayflowVersion: 'v2', status, result: { ...report, completionReason: reason },
  }), { status: 200 }));
  const projected = getCloudFlowRun('root', { apiUrl: 'https://cloud-contract.example', token: 'test' });
  if (accepted) {
    // Current Cloud projection intentionally loses the authored diagnostic.
    await expect(projected).resolves.toEqual({ runId: 'root', status: 'completed', completionReason: 'success' });
  } else await expect(projected).rejects.toMatchObject({ code: 'invalid_response' });
});
