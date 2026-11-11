import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FlowSpec } from '../src/spec.js';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), spawn: vi.fn(), access: vi.fn() }));
vi.mock('node:module', () => ({ createRequire: () => ({ resolve: mocks.resolve }) }));
vi.mock('node:child_process', () => ({ spawnSync: mocks.spawn }));
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(),
  accessSync: mocks.access, constants: { X_OK: 1 } }));
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCommunicationEnvironment } from '../src/communication/preflight.js';
const spec: FlowSpec = { version: '0.1.0', steps: [{ id: 'a', type: 'agent', cli: 'codex', instruction: JSON.stringify({
  type: 'relayflows.communication.v1', instruction: '', incoming: ['b'], outgoing: [], timeoutMs: 1000,
}) }] };
const dir = mkdtempSync(join(tmpdir(), 'flows-run-token-'));
const runFile = join(dir, 'relaycast-run.json');
const future = new Date(Date.now() + 600_000).toISOString();
// Synthetic value; never a real credential.
const SYNTHETIC = 'rt_live_synthetic0preflight';
function ready() {
  mocks.resolve.mockReturnValue('/installed/broker-path.js');
  mocks.spawn.mockReturnValue({ status: 0, stdout: '/installed/broker' });
}
beforeEach(() => { vi.stubEnv('RELAY_RUN_TOKEN_FILE', undefined); });
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
it('ordinary flows never inspect Relay credentials, packages, or broker', () => {
  vi.stubEnv('RELAY_API_KEY', undefined);
  checkCommunicationEnvironment({ version: '0.1.0', steps: [{ id: 'plain', type: 'agent', instruction: 'hello' }] });
  expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.spawn).not.toHaveBeenCalled();
});
it('refuses missing credentials before package or daemon access', () => {
  vi.stubEnv('RELAY_API_KEY', undefined);
  expect(() => checkCommunicationEnvironment(spec)).toThrow('requires RELAY_API_KEY');
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it('refuses missing optional packages', () => {
  vi.stubEnv('RELAY_API_KEY', 'rk_live_test'); mocks.resolve.mockImplementation(() => { throw Error('MODULE_NOT_FOUND'); });
  expect(() => checkCommunicationEnvironment(spec)).toThrow('optional @agent-relay');
});
it.each(['missing', 'not-executable', 'ready'])('checks the broker executable: %s', state => {
  vi.stubEnv('RELAY_API_KEY', 'rk_live_test'); mocks.resolve.mockReturnValue('/installed/broker-path.js');
  mocks.spawn.mockReturnValue({ status: state === 'missing' ? 1 : 0, stdout: '/installed/broker' });
  if (state === 'not-executable') mocks.access.mockImplementation(() => { throw Error('EACCES'); });
  if (state === 'ready') expect(() => checkCommunicationEnvironment(spec)).not.toThrow();
  else expect(() => checkCommunicationEnvironment(spec)).toThrow('executable Relay broker');
});
it('accepts a valid run token file without RELAY_API_KEY', () => {
  writeFileSync(runFile, JSON.stringify({ token: SYNTHETIC, expiresAt: future }), { mode: 0o600 });
  vi.stubEnv('RELAY_API_KEY', undefined); vi.stubEnv('RELAY_RUN_TOKEN_FILE', runFile); ready();
  expect(() => checkCommunicationEnvironment(spec)).not.toThrow();
});
it('prefers the run token file over RELAY_API_KEY', () => {
  writeFileSync(runFile, JSON.stringify({ token: SYNTHETIC, expiresAt: new Date(Date.now() - 1000).toISOString() }));
  vi.stubEnv('RELAY_API_KEY', 'rk_live_test'); vi.stubEnv('RELAY_RUN_TOKEN_FILE', runFile); ready();
  expect(() => checkCommunicationEnvironment(spec)).toThrow('expired');
});
it.each([
  ['missing file', null, 'readable file'],
  ['invalid JSON', `{"token":"${SYNTHETIC}"`, 'valid JSON'],
  ['workspace key', JSON.stringify({ token: 'rk_live_synthetic', expiresAt: future }), 'rt_live_'],
  ['empty token', JSON.stringify({ token: 'rt_live_', expiresAt: future }), 'rt_live_'],
  ['no expiry', JSON.stringify({ token: SYNTHETIC }), 'expiresAt'],
  ['expired', JSON.stringify({ token: SYNTHETIC, expiresAt: '2020-01-01T00:00:00Z' }), 'expired'],
  ['refresh token', JSON.stringify({ token: SYNTHETIC, expiresAt: future, refreshToken: 'rt_refresh_x' }), 'refresh token'],
])('rejects a bad run token file: %s', (_name, contents, message) => {
  rmSync(runFile, { force: true });
  if (contents !== null) writeFileSync(runFile, contents);
  vi.stubEnv('RELAY_RUN_TOKEN_FILE', runFile); ready();
  let thrown: Error | undefined;
  try { checkCommunicationEnvironment(spec); } catch (error) { thrown = error as Error; }
  expect(thrown?.message).toContain(message);
  expect(thrown?.message).not.toContain('synthetic');
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it('rejects a relative run token file path', () => {
  vi.stubEnv('RELAY_RUN_TOKEN_FILE', 'relative/run.json');
  expect(() => checkCommunicationEnvironment(spec)).toThrow('absolute path');
});
