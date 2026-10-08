import { expect, it, vi } from 'vitest';
import { check, fixture, useHelperSurfaceEnv } from './helper-surface-fixture.js';

// An early trigger-leg failure (a failed extension probe, say) reports none of
// the helper diagnostics the helper leg already produced.
vi.mock('../src/cli/check-triggers.js', async original => ({
  ...await original<typeof import('../src/cli/check-triggers.js')>(),
  checkAuthoredTriggers: async () => ({ report: { ok: false, gates: [], resolutions: [], diagnostics: [
    { severity: 'refusal', kind: 'probe_failed', message: 'extension probe failed' },
  ] } }),
}));

useHelperSurfaceEnv();

it('keeps the helper warning when trigger inspection fails early', async () => {
  const result = await check(fixture('', '{ tools: { slack: true } },'), true);
  const report = JSON.parse(result.stdout.join(''));
  expect(report.ok).toBe(false);
  expect(report.diagnostics.map((d: { kind: string }) => d.kind)).toEqual(
    expect.arrayContaining(['probe_failed', 'helper_credential_unresolved']));
  expect(report.diagnostics.filter((d: { kind: string }) => d.kind === 'helper_credential_unresolved')).toHaveLength(1);
});
