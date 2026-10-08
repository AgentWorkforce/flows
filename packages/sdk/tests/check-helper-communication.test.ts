import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { check, directories, fixture, shippedExample, useHelperSurfaceEnv } from './helper-surface-fixture.js';
import { helperCredentialDiagnostics } from '../src/cli/check-helper-surface.js';
import { checkAuthoredFlow } from '../src/cli/check.js';
import type { FlowSpec } from '../src/spec.js';

useHelperSurfaceEnv();

function communicatingYaml(provider: 'slack' | 'linear' | 'github', mounted: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'helper-surface-comm-'));
  directories.push(dir);
  const cli = join(dir, 'codex');
  writeFileSync(cli, '#!/bin/sh\nexit 0\n');
  chmodSync(cli, 0o755);
  if (mounted) {
    mkdirSync(join(dir, provider));
    vi.stubEnv('RELAYFILE_MOUNT_PATH', dir);
  }
  const helper = provider === 'slack' ? { slack: { post: { channel: '#test', text: 'hi' } } }
    : provider === 'linear' ? { linear: { createIssue: { teamId: 'eng', title: 'hi' } } }
      : { github: { createIssue: { owner: 'o', repo: 'r', title: 'hi', body: 'hi' } } };
  const spec = { version: '0.1.0', cli, steps: [
    { id: 'a', type: 'agent', instruction: 'send' }, { id: 'b', type: 'agent', instruction: 'receive' },
    { id: 'notify', ...helper },
  ], communication: { links: [{ from: 'a', to: 'b' }] } } as unknown as FlowSpec;
  const config = { directory: dir, models: [], executors: [] };
  return (warn: boolean) => checkAuthoredFlow(spec, join(dir, 'flow.yaml'),
    { projectConfig: config }, { warnUnresolvedHelperCredential: warn }).report;
}
it('inspecting past a missing mount never admits the flow for execution', () => {
  vi.stubEnv('RELAY_API_KEY', 'rk_live_test');
  const dir = mkdtempSync(join(tmpdir(), 'helper-surface-admit-'));
  directories.push(dir);
  const cli = join(dir, 'codex');
  writeFileSync(cli, '#!/bin/sh\nexit 0\n');
  chmodSync(cli, 0o755);
  const spec = { version: '0.1.0', cli, steps: [{ id: 'a', type: 'agent', instruction: 'go' },
    { id: 'notify', slack: { post: { channel: '#test', text: 'hi' } } }] } as unknown as FlowSpec;
  const config = { directory: dir, models: [], executors: [] };
  const checked = checkAuthoredFlow(spec, join(dir, 'flow.yaml'), { projectConfig: config },
    { warnUnresolvedHelperCredential: true });
  expect(checked.report.ok).toBe(true);
  expect(checked.flow).toBeUndefined();
  const strict = checkAuthoredFlow(spec, join(dir, 'flow.yaml'), { projectConfig: config });
  expect(strict.report.ok).toBe(false);
  expect(strict.flow).toBeUndefined();
});
it.each([false, true])('keeps the communication refusal and budget warning whether or not Slack is mounted (mounted=%s)', mounted => {
  vi.stubEnv('RELAY_API_KEY', '');
  const report = communicatingYaml('slack', mounted)(true);
  expect(report.ok).toBe(false);
  expect(report.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: 'refusal', kind: 'probe_failed', message: expect.stringContaining('RELAY_API_KEY') }),
    expect.objectContaining({ severity: 'warning', kind: 'budget_unmetered' }),
  ]));
  expect(report.diagnostics.some(d => d.kind === 'helper_credential_unresolved')).toBe(!mounted);
});
it('YAML Slack keeps the mock remedy because the YAML execution path honours it', () => {
  const report = communicatingYaml('slack', false)(true);
  const warning = report.diagnostics.find(d => d.kind === 'helper_credential_unresolved');
  expect(warning?.message).toContain('RELAYFLOWS_SLACK_MOCK=1');
});
it.each(['linear', 'github'] as const)('YAML %s offers only remedies its execution path supports', provider => {
  const check = communicatingYaml(provider, false);
  const report = check(true);
  const warning = report.diagnostics.find(d => d.kind === 'helper_credential_unresolved');
  expect(warning?.message).toContain(`relayfile ${provider} mount`);
  expect(warning?.message).not.toMatch(/_MOCK=1/);
  expect(warning?.message).toContain('[helper_mount_required]');
});
it('authored TS helpers keep their provider-specific mock remedy', () => {
  const { diagnostics } = helperCredentialDiagnostics([{ severity: 'refusal', kind: 'helper_provider.mount_required',
    message: 'f.linear requires a relayfile linear mount; direct-token transport is not implemented.' }]);
  expect(diagnostics[0]?.message).toContain('RELAYFLOWS_LINEAR_MOCK=1');
});
