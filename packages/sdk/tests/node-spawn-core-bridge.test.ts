import { describe, expect, it, vi } from 'vitest';

import { assertCoreBridgeApi, loadCoreBridge } from '../src/node-spawn-local.js';

// 18.0.0 implements only these six CoreBridgeApi methods. Undefined exports let
// Vitest expose the same missing lifecycle surface through a virtual module.
const publicCoreBridge180Shape = vi.hoisted(() => ({
  connectCore: vi.fn(),
  authenticate: vi.fn(),
  spawnTargets: vi.fn(),
  spawnInvoke: vi.fn(),
  spawnStatus: vi.fn(),
  spawnRelease: vi.fn(),
  readCallerDescriptor: undefined,
  requireServiceCallerMethods: undefined,
  assertServiceCallerIdentity: undefined,
  serviceCallerIdentity: undefined,
  serviceCallerInboxOpen: undefined,
  serviceCallerInboxNext: undefined,
  serviceCallerInboxAck: undefined,
  serviceCallerInboxFail: undefined,
  serviceCallerInboxClose: undefined,
  serviceCallerDisconnect: undefined,
}));

vi.mock('@agent-relay/core-bridge', () => publicCoreBridge180Shape);

const schemaV2CoreBridge181Shape = {
  ...publicCoreBridge180Shape,
  readCallerDescriptor: vi.fn(),
  requireServiceCallerMethods: vi.fn(),
  assertServiceCallerIdentity: vi.fn(),
  serviceCallerIdentity: vi.fn(),
  serviceCallerInboxOpen: vi.fn(),
  serviceCallerInboxNext: vi.fn(),
  serviceCallerInboxAck: vi.fn(),
  serviceCallerInboxFail: vi.fn(),
  serviceCallerInboxClose: vi.fn(),
  serviceCallerDisconnect: vi.fn(),
};

describe('optional core-bridge contract', () => {
  it('fails closed while loading the incomplete public 18.0 module shape', async () => {
    let failure: unknown;
    try {
      await loadCoreBridge();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'core_bridge_unavailable',
      message: expect.stringContaining('Install >=18.1.0 <19'),
      cause: {
        missingMethods: [
          'readCallerDescriptor',
          'requireServiceCallerMethods',
          'assertServiceCallerIdentity',
          'serviceCallerIdentity',
          'serviceCallerInboxOpen',
          'serviceCallerInboxNext',
          'serviceCallerInboxAck',
          'serviceCallerInboxFail',
          'serviceCallerInboxClose',
          'serviceCallerDisconnect',
        ],
        requiredVersion: '>=18.1.0 <19',
      },
    });
  });

  it('accepts the complete 18.1 schema-v2 lifecycle module shape', () => {
    expect(() => assertCoreBridgeApi(schemaV2CoreBridge181Shape)).not.toThrow();
  });
});
