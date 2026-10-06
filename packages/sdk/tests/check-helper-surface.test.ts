import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { checkHelperBody } from '../src/cli/check-helper-body.js';
import { checkAuthoredTriggers } from '../src/cli/check-triggers.js';
import { CHECK_WARNING_KINDS } from '../src/failure-kinds.js';
import { helperCredentialDiagnostics } from '../src/cli/check-helper-surface.js';

const directories: string[] = [];
beforeEach(() => {
  for (const key of ['SLACK_BOT_TOKEN', 'RELAYFLOWS_SLACK_MOCK', 'RELAYFLOWS_LINEAR_MOCK',
    'RELAYFLOWS_NOTION_MOCK', 'RELAYFILE_MOUNT_PATH', 'WORKSPACE_ROOT',
    'WORKFORCE_SANDBOX_ROOT', 'RELAYFILE_MOUNT_ROOT', 'RELAYFILE_ROOT']) vi.stubEnv(key, '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(body = "await f.slack.post('#test', 'hi');", header = '', name = 'test.flow.ts') {
  const dir = mkdtempSync(join(tmpdir(), 'helper-surface-'));
  directories.push(dir);
  writeFileSync(join(dir, 'flows.json'), '{}');
  mkdirSync(join(dir, 'node_modules/@relayflows'), { recursive: true });
  symlinkSync(resolve('node_modules/@relayflows/surface'), join(dir, 'node_modules/@relayflows/surface'));
  const path = join(dir, name);
  writeFileSync(path, `import { flow } from '@relayflows/surface';
export default flow('test', ${header} async f => { ${body} f.done('success'); });`);
  return path;
}
async function check(path: string, json = false, verb = 'check') {
  const lines: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = await runCli([verb, ...(json ? ['--json'] : []), path, ...(verb === 'run' && path.endsWith('.flow.ts') ? ['--input', '{}'] : [])], {
    stdout: line => { stdout.push(line); lines.push(line); },
    stderr: line => { stderr.push(line); lines.push(line); },
  });
  return { exit, lines, stdout, stderr };
}
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
it.each([
  ['airtable', "await f.airtable.createRecord('base', 'table', {});"],
  ['notion appendBlock', "await f.notion.appendBlock('page', {});"],
])('still refuses unsupported %s without a mount', async (_name, body) => {
  const result = await check(fixture(body));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
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
