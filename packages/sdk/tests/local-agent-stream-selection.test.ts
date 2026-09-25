import { describe, expect, it } from 'vitest';
import { declaredLocalAgentStreams } from '../src/local-agent.js';
import { toKernelSpec } from '../src/compile.js';

describe('local agent stream registration', () => {
  it('deduplicates ordinary streams without registering conversation-only streams or mutating the spec', () => {
    const spec = toKernelSpec({ version: '0.1.0', name: 'mixed', steps: [
      { id: 'one', type: 'agent', instruction: 'ordinary', surfaces: { streams: [{ stream: 'shared' }, { stream: 'first' }] } },
      { id: 'two', type: 'agent', instruction: 'ordinary', surfaces: { streams: [{ stream: 'shared' }] } },
      { id: 'peer', type: 'agent', instruction: JSON.stringify({
        type: 'relayflows.communication.v1', instruction: 'talk', incoming: [], outgoing: ['other'], timeoutMs: 1000,
      }), surfaces: { streams: [{ stream: 'conversation-receipts' }, { stream: 'conversation-outgoing' }] } },
      { id: 'pure', type: 'deterministic', command: 'true' },
    ] });
    const before = structuredClone(spec);
    expect(declaredLocalAgentStreams(spec)).toEqual(['shared', 'first']);
    expect(spec).toEqual(before);
  });
});
