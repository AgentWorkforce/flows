import * as publicCoreBridge181 from '@agent-relay/core-bridge';
import { describe, expect, it } from 'vitest';

import { assertCoreBridgeApi } from '../src/node-spawn-local.js';

describe('public core-bridge release contract', () => {
  it('accepts the exact installed 18.1.0 schema-v2 lifecycle surface', () => {
    expect(() => assertCoreBridgeApi(publicCoreBridge181)).not.toThrow();
  });
});
