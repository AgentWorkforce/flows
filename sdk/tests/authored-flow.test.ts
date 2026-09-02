import { describe, expect, it, vi } from 'vitest';
import type { Ctx } from '@relayflows/surface';
import { getAuthoredFlowDefinition } from '../src/authored-flow.js';

describe('authored flow runtime bridge', () => {
  it('recovers and invokes a black-box .flow.ts body with an injected context', async () => {
    const authoredModule = await import('./fixtures/runtime-bridge.flow.js');
    const definition = getAuthoredFlowDefinition(authoredModule.default);

    expect(definition.name).toBe('runtime-bridge-fixture');
    expect(definition.header).toEqual({
      identity: 'fixture-agent',
      tools: { mcp: ['fixture-tool'] },
    });
    expect(Object.isFrozen(definition)).toBe(true);

    const done = vi.fn();
    await definition.body({ done } as unknown as Ctx);
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith('success');
  });
});
