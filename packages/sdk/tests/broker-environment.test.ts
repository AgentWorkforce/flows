import { beforeEach, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ resolve: vi.fn(), spawn: vi.fn() }));
vi.mock('node:module', () => ({ createRequire: () => ({ resolve: fake.resolve }) }));
vi.mock('node:child_process', () => ({ spawnSync: fake.spawn }));
import { checkBrokerEnvironment } from '../src/communication/broker-preflight.js';
beforeEach(() => vi.resetAllMocks());
it('refuses missing packages before attempting a connection', () => {
  fake.resolve.mockImplementation(() => { throw new Error('MODULE_NOT_FOUND'); });
  expect(() => checkBrokerEnvironment('/run')).toThrow('optional @agent-relay');
  expect(fake.spawn).not.toHaveBeenCalled();
});
it.each([1, null])('refuses unavailable or timed-out local broker probes (%s)', status => {
  fake.resolve.mockReturnValue('/installed/driver.js'); fake.spawn.mockReturnValue({ status });
  expect(() => checkBrokerEnvironment('/run')).toThrow('reachable local Relay broker');
});
it('uses SDK connect and healthCheck without spawning a broker or agent', () => {
  fake.resolve.mockReturnValue('/installed/driver.js'); fake.spawn.mockReturnValue({ status: 0 });
  expect(() => checkBrokerEnvironment('/run')).not.toThrow();
  const args = fake.spawn.mock.calls[0]![1] as string[];
  expect(args[2]).toContain('HarnessDriverClient.connect');
  expect(args[2]).toContain('client.healthCheck');
  expect(args[2]).not.toContain('.spawn');
  expect(args.slice(-2)).toEqual(['file:///installed/driver.js', '/run']);
  expect(fake.spawn.mock.calls[0]![2]).toMatchObject({ timeout: 10_000 });
});
