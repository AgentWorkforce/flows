import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../sdk/package.json', import.meta.url));
const Ajv = require('ajv/dist/2020.js').default;

test('generates readonly scope arrays as strict JSON arrays without schema drift', () => {
  const directory = mkdtempSync(join(tmpdir(), 'relayflows-schema-generation-'));
  try {
    const destination = join(directory, 'flows.schema.json');
    execFileSync('node', [
      fileURLToPath(new URL('../../../scripts/generate-json-schema.mjs', import.meta.url)), destination,
    ]);
    const generated = readFileSync(destination, 'utf8');
    expect(generated).toBe(readFileSync(new URL('../flows.schema.json', import.meta.url), 'utf8'));
    const schema = JSON.parse(generated);
    const validate = new Ajv({ strict: false, validateFormats: false }).compile(schema);
    const base = { version: '0.1.0', steps: [{ id: 'one', type: 'deterministic', command: 'true' }] };
    for (const grant of ['repo: readonly', ['repo: readonly'], []]) {
      expect(validate({ ...base, workspace: grant, tools: { fs: grant } })).toBe(true);
    }
    for (const grant of [false, null, 1, {}, [1], ['repo: readonly', false]]) {
      expect(validate({ ...base, workspace: grant })).toBe(false);
      expect(validate({ ...base, tools: { fs: grant } })).toBe(false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
