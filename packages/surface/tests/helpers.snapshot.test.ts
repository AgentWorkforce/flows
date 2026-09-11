import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('regenerates helpers byte-identically from the pinned adapter', () => {
  const guard = fileURLToPath(new URL('../scripts/check-generated-helpers.mjs', import.meta.url));
  expect(execFileSync(process.execPath, [guard], { encoding: 'utf8' }))
    .toContain('HELPERS_GENERATED_OK airtable.ts, asana.ts, azure-blob.ts');
});
