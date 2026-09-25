import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { helperProviders } from '../src/helpers/providers.js';

it('regenerates helpers byte-identically from the pinned adapter', () => {
  const guard = fileURLToPath(new URL('../scripts/check-generated-helpers.mjs', import.meta.url));
  expect(execFileSync(process.execPath, [guard], { encoding: 'utf8' }))
    .toContain('HELPERS_GENERATED_OK airtable.ts, asana.ts, azure-blob.ts');
});

it('publishes the exact sorted resource catalog, including current GitLab parity', () => {
  for (const provider of helperProviders) {
    expect(provider.resources).toEqual([...provider.resources].sort());
    if (!provider.supported) expect(provider.resources).toEqual([]);
  }
  expect(helperProviders.find(provider => provider.provider === 'gitlab')).toMatchObject({
    supported: true,
    resources: [
      'close-merge-request', 'comments', 'discussions', 'issues', 'merge',
      'merge-requests', 'refs',
    ],
  });
});
