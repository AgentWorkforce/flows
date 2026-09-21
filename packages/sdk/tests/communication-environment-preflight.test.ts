import { afterEach, expect, it, vi } from 'vitest';
import type { FlowSpec } from '../src/spec.js';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), spawn: vi.fn(), access: vi.fn() }));
vi.mock('node:module', () => ({ createRequire: () => ({ resolve: mocks.resolve }) }));
vi.mock('node:child_process', () => ({ spawnSync: mocks.spawn }));
vi.mock('node:fs', () => ({ accessSync: mocks.access, constants: { X_OK: 1 } }));
import { checkCommunicationEnvironment } from '../src/communication/preflight.js';
const spec: FlowSpec = { version: '0.1.0', steps: [{ id: 'a', type: 'agent', cli: 'codex', instruction: JSON.stringify({
  type: 'relayflows.communication.v1', instruction: '', incoming: ['b'], outgoing: [], timeoutMs: 1000,
}) }] };
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
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
