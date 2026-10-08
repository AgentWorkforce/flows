import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { check, directories, fixture, shippedExample, useHelperSurfaceEnv } from './helper-surface-fixture.js';

useHelperSurfaceEnv();

it.each(['test.flow.mjs', 'test.flow.js'])('Cloud requirement reading covers %s, so submit can verify its integrations', async name => {
  const { flowRequirementsForPath } = await import('../src/cli/cloud-connect-cli.js');
  const path = fixture('', '{ tools: { slack: true } },', name.replace('test', 'cloud'));
  writeFileSync(join(dirname(path), 'package.json'), '{"type":"module"}');
  const requirements = await flowRequirementsForPath(path);
  expect(requirements?.integrations).toContainEqual(expect.objectContaining({ provider: 'slack' }));
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
