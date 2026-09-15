import { describe, expect, it } from 'vitest';
import { authoredChildAdmissionKey, authoredLocalAgentStream } from '../src/authored-admission.js';

describe('authored child admission identity', () => {
  it('is stable within one root and distinct across roots and operations', () => {
    const key = authoredChildAdmissionKey('root-a', 'llm-1');
    expect(key).toMatch(/^authored-child:[a-f0-9]{64}$/u);
    expect(authoredChildAdmissionKey('root-a', 'llm-1')).toBe(key);
    expect(authoredChildAdmissionKey('root-a', 'agent-2')).not.toBe(key);
    expect(authoredChildAdmissionKey('root-b', 'llm-1')).not.toBe(key);
    expect(authoredChildAdmissionKey(undefined, 'llm-1')).toBeUndefined();
  });

  it('pins a local agent surface to the caller-owned root identity', () => {
    const stream = authoredLocalAgentStream('cloud-run-1');
    expect(stream).toMatch(/^local-agent-[a-f0-9]{64}$/u);
    expect(authoredLocalAgentStream('cloud-run-1')).toBe(stream);
    expect(authoredLocalAgentStream('cloud-run-2')).not.toBe(stream);
  });
});
