import { describe, expect, it } from 'vitest';
import {
  registeredAdapters,
  resolveAdapter,
  resolveAdapterKind,
} from '../../src/adapters/index.js';
import {
  agentExecution,
  authenticationProbe,
  cliAdapterKind,
  llmExecution,
  modelReadinessProbe,
  adapterIdentification,
} from '../../src/cli-adapter.js';

describe('adapters registry + cli-adapter parity', () => {
  it('registers claude, codex, and the wrapper protocol', () => {
    const kinds = Object.keys(registeredAdapters()).sort();
    expect(kinds).toEqual(['claude', 'codex', 'relayflows-wrapper-v1']);
  });

  it('resolves by basename', () => {
    expect(resolveAdapter('/usr/local/bin/claude').kind).toBe('claude');
    expect(resolveAdapter('/opt/homebrew/bin/codex').kind).toBe('codex');
    expect(resolveAdapter('/opt/homebrew/bin/codex.exe').kind).toBe('codex');
    expect(resolveAdapter('./bin/my-flow-wrapper').kind).toBe('relayflows-wrapper-v1');
    expect(resolveAdapterKind('claude')).toBe('claude');
    expect(cliAdapterKind('codex')).toBe('codex');
  });

  it('legacy helpers match adapter contracts', () => {
    for (const kind of ['claude', 'codex'] as const) {
      const adapter = registeredAdapters()[kind];
      expect(agentExecution(kind, 'X', 'M')).toEqual(adapter.buildAgentInvocation('X', 'M'));
      expect(llmExecution(kind, 'Y', 'M')).toEqual(adapter.buildLlmInvocation('Y', 'M'));
      expect(authenticationProbe(kind)).toEqual(adapter.buildAuthProbe());
      expect(modelReadinessProbe(kind, 'M')).toEqual(adapter.buildModelReadinessProbe('M'));
      expect(adapterIdentification(kind)).toEqual(adapter.buildIdentification());
    }
  });

  it('wrapper adapter refuses direct-argv execution', () => {
    const wrapper = registeredAdapters()['relayflows-wrapper-v1'];
    expect(() => wrapper.buildAgentInvocation('X')).toThrow(/same-process session/);
    expect(() => wrapper.buildLlmInvocation('Y')).toThrow(/same-process session/);
    expect(wrapper.buildIdentification().expectedStdout).toBe('relayflows-agent-cli-v1');
  });
});
