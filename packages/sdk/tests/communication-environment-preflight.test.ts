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
it.each([undefined, '', 'rk_live_test'])('always refuses retired communication without probing the broker (credential=%s)', credential => {
  vi.stubEnv('RELAY_API_KEY', credential);
  expect(() => checkCommunicationEnvironment(spec)).toThrow('broker/PTy was removed');
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.access).not.toHaveBeenCalled();
});
