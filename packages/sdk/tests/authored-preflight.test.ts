import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { authoredPreflight } from '../src/authored-preflight.js';
import { compileSpec, kernelToAuthoring, toKernelSpec } from '../src/compile.js';
import { SPEC_SCHEMA_VERSION, type FlowSpec } from '../src/spec.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function setup(environment?: NodeJS.ProcessEnv, bareCli = false) {
  const directory = mkdtempSync(join(tmpdir(), 'authored-preflight-'));
  directories.push(directory);
  const calls = join(directory, 'calls');
  const cli = join(directory, 'wrapper');
  writeFileSync(cli, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, 'probe\\n');
if (process.argv[2] === '--relayflows-adapter-v1') console.log('relayflows-agent-cli-v1');
else process.exit(process.env.ANTHROPIC_API_KEY === 'house-key' ? 0 : 1);
`);
  chmodSync(cli, 0o755);
  writeFileSync(join(directory, 'flows.json'), JSON.stringify({ cli: bareCli ? 'wrapper' : cli, models: ['allowed'] }));
  const probeEnvironment = bareCli
    ? { ...environment, PATH: `${directory}:${environment?.PATH ?? process.env.PATH ?? ''}` }
    : environment;
  return { calls, cli, check: authoredPreflight(join(directory, 'test.flow.ts'), probeEnvironment) };
}
function spec(id: string, model = 'allowed'): FlowSpec {
  return { version: SPEC_SCHEMA_VERSION, name: 'test', steps: [{ id, type: 'llm', prompt: 'hello', model }] };
}
function agentSpec(id: string, model = 'allowed'): FlowSpec {
  return { version: SPEC_SCHEMA_VERSION, name: 'test', steps: [{ id, type: 'agent', instruction: 'review', model }] };
}

it('refuses unknown models before launching any provider probe', async () => {
  const { check, calls } = setup();
  const result = await check(spec('one', 'forbidden'));
  expect(result.report.diagnostics).toContainEqual(expect.objectContaining({ kind: 'model_unknown' }));
  expect(existsSync(calls)).toBe(false);
});

it('refuses malformed specs before launching any provider probe', async () => {
  const { check, calls } = setup();
  const invalid = spec('one');
  (invalid.steps[0] as { prompt: unknown }).prompt = 42;
  expect((await check(invalid)).report.ok).toBe(false);
  expect(existsSync(calls)).toBe(false);
});

it('shares failed facts across callers but retains each step identity', async () => {
  const { check, calls } = setup();
  const results = await Promise.all(['one', 'two'].map(id => check(spec(id))));
  for (const [index, result] of results.entries()) {
    expect(result.report.diagnostics).toContainEqual(expect.objectContaining({
      kind: 'cli_unauthenticated', stepId: index === 0 ? 'one' : 'two',
    }));
  }
  // One identification, one exact-model probe, one auth classification.
  expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(3);
});

it('uses the isolated provider environment during authored agent preflight', async () => {
  const { check, cli } = setup({ ...process.env, ANTHROPIC_API_KEY: 'house-key' }, true);
  const result = await check(agentSpec('one'));
  expect(result.report.ok).toBe(true);
  expect(result.flow?.steps[0]).toEqual(expect.objectContaining({ cli }));
});

it('carries a symlink declaration identity beside its canonical executable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'authored-preflight-symlink-'));
  directories.push(directory);
  const calls = join(directory, 'calls');
  const target = join(directory, 'provider-cli.js');
  const link = join(directory, 'claude');
  writeFileSync(target, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');
process.exit(process.argv[2] === '--relayflows-adapter-v1' ? 9 : 0);
`);
  chmodSync(target, 0o755);
  symlinkSync(target, link);
  writeFileSync(join(directory, 'flows.json'), JSON.stringify({ cli: 'claude', models: ['allowed'] }));
  const check = authoredPreflight(join(directory, 'test.flow.ts'), {
    ...process.env,
    PATH: `${directory}:${process.env.PATH ?? ''}`,
  });
  const result = await check(agentSpec('one'));
  expect(result.report.ok).toBe(true);
  expect(result.flow?.steps[0]).toMatchObject({ cli: realpathSync(target) });
  const kernel = toKernelSpec(result.flow!);
  expect(kernel.steps[0]).toMatchObject({
    cli: realpathSync(target),
    cli_identity: 'claude',
  });
  expect(toKernelSpec(compileSpec(kernelToAuthoring(kernel))).steps[0]).toMatchObject({
    cli: realpathSync(target),
    cli_identity: 'claude',
  });
  expect(readFileSync(calls, 'utf8')).not.toContain('--relayflows-adapter-v1');
});
