import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { probeCli, probeCliAsync } from '../src/cli/cli-probe.js';
import * as adapters from '../src/cli-adapter.js';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function wrapper(body: string) {
  const directory = mkdtempSync(join(tmpdir(), 'probe-drivers-'));
  directories.push(directory);
  const path = join(directory, 'wrapper');
  writeFileSync(path, '#!/usr/bin/env node\n' + body);
  chmodSync(path, 0o755);
  return { path, directory };
}
const identify = `if (process.argv[2] === '--relayflows-adapter-v1') {
  console.log('relayflows-agent-cli-v1'); process.exit(0);
}`;

it.each([
  ['success', 'process.exit(0)', { authenticated: true, modelAvailable: true }],
  ['model denied', "process.exit(process.env.RELAYFLOW_MODEL ? 1 : 0)", { authenticated: true, modelAvailable: false }],
  ['auth denied', "console.error('person@example.com sk-123456789abcdef'); process.exit(1)",
    { authenticated: false, modelAvailable: false, authExitCode: 1,
      authFailureDetail: '<redacted-email> <redacted-token>' }],
] as const)('keeps synchronous and asynchronous classification equal: %s', async (_name, body, expected) => {
  const { path, directory } = wrapper(identify + body);
  const sync = probeCli(path, directory, 'test-model');
  expect(sync).toMatchObject(expected);
  expect(await probeCliAsync(path, directory, 'test-model')).toEqual(sync);
});

it('keeps missing executables and unsupported identification fail closed', async () => {
  const { path, directory } = wrapper("console.log('not a wrapper')");
  expect(await probeCliAsync(path, directory)).toEqual(probeCli(path, directory));
  expect(await probeCliAsync('./missing', directory)).toEqual({ exists: false, authenticated: false });
  expect(await probeCliAsync('relayflows-no-such-executable', directory)).toEqual({ exists: false, authenticated: false });
});

it('reports timeout in both drivers while the async driver leaves the loop free', async () => {
  const { path, directory } = wrapper(identify + 'setTimeout(() => {}, 10_000);');
  const original = adapters.modelReadinessProbe;
  vi.spyOn(adapters, 'modelReadinessProbe').mockImplementation((kind, model) =>
    ({ ...original(kind, model), timeoutMs: 100 }));
  expect(() => probeCli(path, directory, 'test-model')).toThrow(expect.objectContaining({ detail: 'timeout:100ms' }));
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 20);
  await expect(probeCliAsync(path, directory, 'test-model')).rejects.toMatchObject({ detail: 'timeout:100ms' });
  clearTimeout(timer);
  expect(ticked).toBe(true);
});

it('reports signal termination in both drivers', async () => {
  const { path, directory } = wrapper(identify + "process.kill(process.pid, 'SIGTERM');");
  expect(() => probeCli(path, directory, 'test-model')).toThrow(expect.objectContaining({ detail: 'signal:SIGTERM' }));
  await expect(probeCliAsync(path, directory, 'test-model')).rejects.toMatchObject({ detail: 'signal:SIGTERM' });
});
