import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { authoredPreflight } from '../src/authored-preflight.js';
import { SPEC_SCHEMA_VERSION, type FlowSpec } from '../src/spec.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'authored-preflight-'));
  directories.push(directory);
  const calls = join(directory, 'calls');
  const cli = join(directory, 'wrapper');
  writeFileSync(cli, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, 'probe\\n');
if (process.argv[2] === '--relayflows-adapter-v1') console.log('relayflows-agent-cli-v1');
else process.exit(1);
`);
  chmodSync(cli, 0o755);
  writeFileSync(join(directory, 'flows.json'), JSON.stringify({ cli, models: ['allowed'] }));
  return { calls, check: authoredPreflight(join(directory, 'test.flow.ts')) };
}
function spec(id: string, model = 'allowed'): FlowSpec {
  return { version: SPEC_SCHEMA_VERSION, name: 'test', steps: [{ id, type: 'llm', prompt: 'hello', model }] };
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
