import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { check, directories, fixture, shippedExample, useHelperSurfaceEnv } from './helper-surface-fixture.js';
import { checkHelperBody } from '../src/cli/check-helper-body.js';
import { checkAuthoredTriggers } from '../src/cli/check-triggers.js';
import { CHECK_WARNING_KINDS } from '../src/failure-kinds.js';
import { helperCredentialDiagnostics } from '../src/cli/check-helper-surface.js';

useHelperSurfaceEnv();

it('declares the warning and preserves unrelated refusals and unknown shapes', () => {
  expect(CHECK_WARNING_KINDS).toContain('helper_credential_unresolved');
  const diagnostics = [
    { severity: 'refusal' as const, kind: 'probe_failed' as const, message: 'probe threw' },
    { severity: 'refusal' as const, kind: 'helper_provider.mount_required' as const, message: 'unknown shape' },
  ];
  expect(helperCredentialDiagnostics(diagnostics)).toEqual({ diagnostics, downgraded: false });
});
it('reports the declared integration once after REQUIRES and before CHECK PASSED', async () => {
  const result = await check(fixture('', '{ tools: { slack: true } },'));
  expect(result.exit).toBe(0);
  const requires = result.lines.findIndex(line => line.includes('REQUIRES slack (tools.slack)'));
  const warning = result.lines.findIndex(line => line.includes('[helper_credential_unresolved]'));
  const passed = result.lines.findIndex(line => line.includes('CHECK PASSED'));
  expect(requires).toBeGreaterThanOrEqual(0);
  expect(warning).toBeGreaterThan(requires);
  expect(passed).toBeGreaterThan(warning);
  expect(result.stderr.filter(line => line.includes('[helper_credential_unresolved]'))).toHaveLength(1);
});
it('answers the shipped Cloud-bound stale-issues example instead of refusing it', async () => {
  // The reported defect, on the artifact it was reported against: with no local
  // Slack mount this exited 2 on [helper_slack.credential_missing] and never
  // reached REQUIRES. `flows schedule` / `flows deploy` check Slack as a
  // workspace integration at submit, so inspection has to answer, not refuse.
  const result = await check(shippedExample('stale-issues'));
  expect(result.stderr.filter(line => line.startsWith('REFUSED'))).toEqual([]);
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain('REQUIRES slack (tools.slack), claude (llm step)');
  expect(result.lines.filter(line => line.includes('[helper_credential_unresolved]'))).toHaveLength(1);
});
it('emits one diagnostic in JSON and stderr with integration requirements', async () => {
  const result = await check(fixture('', '{ tools: { slack: true } },'), true);
  expect(result.exit).toBe(0);
  const report = JSON.parse(result.stdout.join(''));
  expect(report.ok).toBe(true);
  expect(report.diagnostics.filter((d: { kind: string }) => d.kind === 'helper_credential_unresolved')).toHaveLength(1);
  expect(report.requirements.integrations).toContainEqual(expect.objectContaining({ provider: 'slack' }));
  expect(result.stderr.filter(line => line.includes('[helper_credential_unresolved]'))).toHaveLength(1);
});
it.each(['slack', 'linear'])('discovers body-only %s use', async provider => {
  const result = await check(fixture(`await f.${provider}.${provider === 'slack' ? 'post' : 'comment'}('test', 'hi');`));
  expect(result.exit).toBe(0);
  expect(result.stdout.join('\n')).toContain(`REQUIRES ${provider} (f.${provider})`);
});
it('keeps default and explicit opt-out checks strict, and local run refuses before attach', async () => {
  const path = fixture();
  for (const invocation of [undefined, {}, { warnUnresolvedHelperCredential: false }]) {
    expect((await checkAuthoredTriggers(path, invocation)).report.ok).toBe(false);
  }
  expect((await checkHelperBody(path)).report.ok).toBe(false);
  const result = await check(path, false, 'run');
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_slack.credential_missing]');
});
it('does not warn with a local mount', async () => {
  const path = fixture();
  mkdirSync(join(dirname(path), 'slack'));
  vi.stubEnv('RELAYFILE_MOUNT_PATH', dirname(path));
  const result = await check(path);
  expect(result.exit).toBe(0);
  expect(result.stderr.join('\n')).not.toContain('helper_credential_unresolved');
});
it('warns for a non-flow module without a REQUIRES line', async () => {
  // Only isAuthoredFlowPath modules reach the requirements-producing trigger leg.
  const result = await check(fixture(undefined, '', 'slack.mjs'));
  expect(result.exit).toBe(0);
  expect(result.stderr.join('\n')).toContain('[helper_credential_unresolved]');
  expect(result.stdout.join('\n')).not.toContain('REQUIRES');
});
it('warns once for a token without a mount and names the strict refusal', async () => {
  vi.stubEnv('SLACK_BOT_TOKEN', 'test-token');
  const result = await check(fixture());
  expect(result.exit).toBe(0);
  expect(result.stderr.join('\n')).toContain('[helper_slack.mount_required]');
});

function yamlFixture() {
  const path = join(dirname(fixture()), 'notify.yaml');
  writeFileSync(path, `version: '0.1.0'
name: notify
steps:
  - id: notify
    slack:
      post: { channel: '#test', text: hi }
`);
  return path;
}
it('YAML reports both footnotes once after REQUIRES and before CHECK PASSED', async () => {
  const result = await check(yamlFixture());
  expect(result.exit).toBe(0);
  const requires = result.lines.findIndex(line => line.includes('REQUIRES slack (step "notify")'));
  const passed = result.lines.findIndex(line => line.includes('CHECK PASSED'));
  expect(requires).toBeGreaterThanOrEqual(0);
  for (const kind of ['helper_credential_unresolved', 'agent_worker_unresolved']) {
    const matches = result.lines.flatMap((line, index) => line.includes(`[${kind}]`) ? [index] : []);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBeGreaterThan(requires);
    expect(matches[0]).toBeLessThan(passed);
  }
});
it('YAML local run still refuses a missing mount', async () => {
  const result = await check(yamlFixture(), false, 'run');
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_mount_required]');
});
it('YAML with a mount reports the integration without a credential warning or harness', async () => {
  const path = yamlFixture();
  mkdirSync(join(dirname(path), 'slack'));
  vi.stubEnv('RELAYFILE_MOUNT_PATH', dirname(path));
  const result = await check(path, true);
  expect(result.exit).toBe(0);
  const report = JSON.parse(result.stdout.join(''));
  expect(report.requirements.integrations).toContainEqual(expect.objectContaining({ provider: 'slack' }));
  expect(report.requirements.harnessUses).toEqual([]);
  expect(report.diagnostics.some((d: { kind: string }) => d.kind === 'helper_credential_unresolved')).toBe(false);
});

it('preserves requirements when compilation refuses and for named agents', async () => {
  const path = yamlFixture();
  for (const extra of ['', "use: ['./missing.yaml']\n"]) {
    writeFileSync(path, `version: '0.1.0'
name: named
${extra}agents:
  reviewer: { cli: codex, model: gpt-5 }
steps:
  - id: review
    type: agent
    agent: reviewer
    instruction: Review
`);
    const result = await check(path, true);
    const report = JSON.parse(result.stdout.join(''));
    expect(report.requirements.harnessUses).toContainEqual({ harness: 'codex', detail: 'step "review"' });
  }
});

it('keeps the helper warning and requirements when activity validation refuses', async () => {
  const result = await check(fixture('f.on(globalThis.source, { idle: "1h" });', '{ tools: { slack: true } },'), true);
  const report = JSON.parse(result.stdout.join(''));
  expect(report.ok).toBe(false);
  expect(report.diagnostics.some((d: { message: string }) => d.message.includes('unbounded_subscription'))).toBe(true);
  expect(report.diagnostics.some((d: { kind: string }) => d.kind === 'helper_credential_unresolved')).toBe(true);
  expect(report.requirements?.integrations).toContainEqual(expect.objectContaining({ provider: 'slack' }));
});
