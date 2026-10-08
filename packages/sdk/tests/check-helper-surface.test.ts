import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { checkHelperBody } from '../src/cli/check-helper-body.js';
import { checkAuthoredTriggers } from '../src/cli/check-triggers.js';
import { CHECK_WARNING_KINDS } from '../src/failure-kinds.js';
import { helperCredentialDiagnostics } from '../src/cli/check-helper-surface.js';
import { checkAuthoredFlow } from '../src/cli/check.js';
import type { FlowSpec } from '../src/spec.js';

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
/**
 * A shipped example, copied where `@relayflows/surface` resolves — the same
 * staging `tests/flow-requirements.test.ts` uses. Copied rather than checked in
 * place because `examples/` carries no `package.json`, so a checkout whose
 * ancestry declares `"type": "commonjs"` cannot import an authored `.flow.ts`
 * there at all; the temp copy declares its own module boundary.
 */
function shippedExample(name: string) {
  const dir = mkdtempSync(join(tmpdir(), 'helper-surface-example-'));
  directories.push(dir);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'flows.json'), '{}');
  mkdirSync(join(dir, 'node_modules/@relayflows'), { recursive: true });
  symlinkSync(resolve('node_modules/@relayflows/surface'), join(dir, 'node_modules/@relayflows/surface'));
  const path = join(dir, `${name}.flow.ts`);
  copyFileSync(resolve('../../examples', name, `${name}.flow.ts`), path);
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
it('does not refuse an unrelated .appendBlock in a Notion flow with no local mount', async () => {
  const body = `const doc = { appendBlock() { return 1; } };
    doc.appendBlock(); // f.notion.appendBlock is not called here
    const note = 'x.appendBlock';
    await f.notion.createPage({ parent: 'p', title: note });`;
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.stderr.join('\n')).not.toContain('[helper_provider.unsupported]');
  expect(result.exit).toBe(0);
  expect(result.stderr.join('\n')).toContain('[helper_credential_unresolved]');
});
it('still refuses a real f.notion.appendBlock through an aliased context name', async () => {
  const path = fixture('', '{ tools: { notion: true } },');
  writeFileSync(path, `import { flow } from '@relayflows/surface';
export default flow('test', { tools: { notion: true } }, async ctx => { await ctx.notion.appendBlock('page', {}); ctx.done('success'); });`);
  const result = await check(path);
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it.each([
  ['an alias', 'const notion = f.notion; await notion.appendBlock("page", {});'],
  ['a destructured helper', 'const { notion } = f; await notion.appendBlock("page", {});'],
])('keeps refusing f.notion.appendBlock reached through %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it('keeps refusing a destructured f.notion.appendBlock method', async () => {
  const result = await check(fixture('const { appendBlock } = f.notion; await appendBlock("page", {});', '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it('does not treat an existence check of f.notion as a handoff', async () => {
  const body = `if (f.notion && typeof f.notion === 'object') await f.notion.createPage({ parent: 'p', title: 't' });
    const doc = { appendBlock() { return 1; } }; doc.appendBlock();`;
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.stderr.join('\n')).not.toContain('[helper_provider.unsupported]');
  expect(result.exit).toBe(0);
});
it.each([
  ['nested destructuring', 'const { notion: { appendBlock } } = f; await appendBlock("page", {});'],
  ['an arrow expression body', 'const get = () => f.notion; await get().appendBlock("page", {});'],
  ['a parameter default', 'const run = async (n = f.notion) => n.appendBlock("page", {}); await run();'],
  ['a nested destructuring default', 'const { appendBlock: add = f.notion.appendBlock } = {}; await add("page", {});'],
])('keeps refusing f.notion.appendBlock reached through %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it('explains an alias-inferred appendBlock refusal and how to avoid it', async () => {
  const aliased = await check(fixture('const notion = f.notion; await notion.createPage({ parent: "p", title: "t" }); const doc = { appendBlock() {} }; doc.appendBlock();', '{ tools: { notion: true } },'));
  expect(aliased.exit).toBe(2);
  expect(aliased.stderr.join('\n')).toContain('f.notion is aliased, passed on or called through a computed name');
  const direct = await check(fixture('await f.notion.createPage({ parent: "p", title: "t" }); const doc = { appendBlock() {} }; doc.appendBlock();', '{ tools: { notion: true } },'));
  expect(direct.exit).toBe(0);
  const real = await check(fixture('await f.notion.appendBlock("page", {});', '{ tools: { notion: true } },'));
  expect(real.stderr.join('\n')).not.toContain('aliased, passed on');
});
it.each(['test.flow.mjs', 'test.flow.js'])('Cloud requirement reading covers %s, so submit can verify its integrations', async name => {
  const { flowRequirementsForPath } = await import('../src/cli/cloud-connect-cli.js');
  const path = fixture('', '{ tools: { slack: true } },', name.replace('test', 'cloud'));
  writeFileSync(join(dirname(path), 'package.json'), '{"type":"module"}');
  const requirements = await flowRequirementsForPath(path);
  expect(requirements?.integrations).toContainEqual(expect.objectContaining({ provider: 'slack' }));
});
it.each([
  ['a computed method', 'const method = "appendBlock"; await f.notion[method]("page", {});'],
  ['a computed namespace', 'const ns = "notion"; await f[ns].appendBlock("page", {});'],
])('keeps refusing f.notion.appendBlock reached through %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it('keeps refusing a computed call through an aliased f.notion', async () => {
  const result = await check(fixture('const notion = f.notion; const method = "appendBlock"; await notion[method]("page", {});', '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it.each([
  ['a computed destructuring key', 'const method = "appendBlock"; const { [method]: append } = f.notion; await append("page", {});'],
  ['a rest element', 'const { createPage, ...rest } = f.notion; await rest.appendBlock("page", {});'],
])('keeps refusing f.notion.appendBlock reached through %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it.each(['test.flow.mjs', 'test.flow.js'])('never prompts to connect integrations for %s, which Cloud submission refuses', async name => {
  const { ensureFlowConnections } = await import('../src/cli/cloud-connect-cli.js');
  const path = fixture('', '{ tools: { slack: true } },', name.replace('test', 'cloud'));
  writeFileSync(join(dirname(path), 'package.json'), '{"type":"module"}');
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'));
  const prompt = vi.fn(async () => true);
  expect(await ensureFlowConnections({ path, prompt } as never, { token: 'test-token' })).toBeUndefined();
  expect(prompt).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  ['Reflect.get', 'await Reflect.get(f.notion, "appendBlock")("page", {});'],
  ['a string-keyed alias', 'const n = f.notion; await n["appendBlock"]("page", {});'],
])('keeps refusing f.notion.appendBlock reached through %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it.each([
  ['a dynamic Reflect.get key', 'const method = String(Date.now()); await Reflect.get(f.notion, method)("page", {});'],
  ['a helper function', 'const call = (n, m) => n[m]; await call(f.notion, "append" + "Block")("page", {});'],
])('keeps refusing when f.notion is handed to %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it.each([
  ['an optional chain', 'const method = String(Date.now()); await Reflect.get(f?.notion, method)("page", {});'],
  ['a logical fallback', 'const method = String(Date.now()); await Reflect.get(f.notion ?? {}, method)("page", {});'],
  ['a spread argument', 'const method = String(Date.now()); await Reflect.get(...[f.notion, method])("page", {});'],
])('keeps refusing when f.notion reaches a call through %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it.each([
  ['an object passed to a call', 'await globalThis.invokeHelper({ notion: f.notion }, "page");'],
  ['a returned helper', 'const get = () => { return f.notion; }; await globalThis.invokeHelper(get, "page");'],
  ['a property assignment', 'const box = {}; box.n = f.notion; await globalThis.invokeHelper(box, "page");'],
])('keeps refusing when f.notion escapes through %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it('an aliased f.notion refuses with the remedy, since its calls cannot be attributed', async () => {
  const result = await check(fixture('const notion = f.notion; await notion.createPage({ parent: "p", title: "t" });', '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('call f.notion methods directly by name');
});
it.each([
  ['an alias handed to a call', 'const notion = f.notion; await globalThis.invokeHelper(notion, "page");'],
  ['a rebound alias handed on', 'const a = f.notion; const b = a; await globalThis.invokeHelper({ b }, "page");'],
  ['a destructured namespace handed on', 'const { notion } = f; await globalThis.invokeHelper(notion, "page");'],
])('keeps refusing when %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it.each([
  ['a short-circuit guard', 'f.notion && await f.notion.createPage({ parent: "p", title: "t" });'],
  ['a direct guard and comparison', 'if (f.notion !== undefined && typeof f.notion === "object") await f.notion.createPage({ parent: "p", title: "t" });'],
])('does not over-refuse %s that only calls supported methods', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.stderr.join('\n')).not.toContain('[helper_provider.unsupported]');
  expect(result.exit).toBe(0);
});
it.each([
  ['a captured alias inside a root-shadowing function', 'const notion = f.notion; function call(f) { return notion.appendBlock("p", {}); } await call(1);'],
  ['an alias used as a default', 'const run = async (n = f.notion) => globalThis.invokeHelper(n); await run();'],
  ['an assignment used as an argument', 'let n; await globalThis.invokeHelper(n = f.notion);'],
])('refuses %s', async (_shape, body) => {
  const result = await check(fixture(body, '{ tools: { notion: true } },'));
  expect(result.exit).toBe(2);
  expect(result.stderr.join('\n')).toContain('[helper_provider.unsupported]');
});
it('keeps the helper warning and requirements when activity validation refuses', async () => {
  const result = await check(fixture('f.on(globalThis.source, { idle: "1h" });', '{ tools: { slack: true } },'), true);
  const report = JSON.parse(result.stdout.join(''));
  expect(report.ok).toBe(false);
  expect(report.diagnostics.some((d: { message: string }) => d.message.includes('unbounded_subscription'))).toBe(true);
  expect(report.diagnostics.some((d: { kind: string }) => d.kind === 'helper_credential_unresolved')).toBe(true);
  expect(report.requirements?.integrations).toContainEqual(expect.objectContaining({ provider: 'slack' }));
});
