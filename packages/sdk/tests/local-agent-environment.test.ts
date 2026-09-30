import { closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LOCAL_AGENT_ENV_FD, localAgentCredentialEnvironment, localAgentEnvironment } from '../src/local-agent-environment.js';

function payloadFd(value: string): number {
  const path = join(tmpdir(), `flows-agent-env-${randomUUID()}.json`);
  writeFileSync(path, value, { mode: 0o600 });
  const fd = openSync(path, 'r');
  unlinkSync(path);
  return fd;
}

describe('local agent environment', () => {
  it('merges descriptor values, removes the marker, and closes the descriptor', () => {
    const fd = payloadFd(JSON.stringify({ ANTHROPIC_API_KEY: 'house-key' }));
    const environment = localAgentEnvironment({ [LOCAL_AGENT_ENV_FD]: String(fd), SAFE: 'yes' });
    expect(environment).toEqual({ SAFE: 'yes', ANTHROPIC_API_KEY: 'house-key' });
    expect(() => closeSync(fd)).toThrow();
  });

  it('preserves live process environment behavior without a descriptor', () => {
    expect(localAgentEnvironment({ SAFE: 'yes' })).toBeUndefined();
  });

  it('serializes only provider credentials to the authored runtime', () => {
    expect(localAgentCredentialEnvironment({ PATH: '/usr/bin', NODE_OPTIONS: '--inspect',
      ANTHROPIC_API_KEY: 'house-key' })).toEqual({ ANTHROPIC_API_KEY: 'house-key' });
  });

  it('removes the inherited descriptor capability from process.env', () => {
    const fd = payloadFd(JSON.stringify({ ANTHROPIC_API_KEY: 'secret' }));
    const prior = process.env[LOCAL_AGENT_ENV_FD];
    process.env[LOCAL_AGENT_ENV_FD] = String(fd);
    try {
      const environment = localAgentEnvironment();
      expect(environment?.ANTHROPIC_API_KEY).toBe('secret');
      expect(environment?.[LOCAL_AGENT_ENV_FD]).toBeUndefined();
      expect(process.env[LOCAL_AGENT_ENV_FD]).toBeUndefined();
    } finally {
      if (prior !== undefined) process.env[LOCAL_AGENT_ENV_FD] = prior;
      else delete process.env[LOCAL_AGENT_ENV_FD];
    }
  });

  it.each([
    ['an invalid descriptor', { [LOCAL_AGENT_ENV_FD]: 'nope' }],
    ['malformed JSON', undefined],
    ['non-string values', undefined],
    ['an execution-setting key', undefined],
  ])('fails closed for %s', (_name, preset) => {
    const fd = preset === undefined
      ? payloadFd(_name === 'malformed JSON' ? '{'
        : _name === 'an execution-setting key' ? JSON.stringify({ PATH: '/host-controlled' })
        : JSON.stringify({ ANTHROPIC_API_KEY: 1 }))
      : undefined;
    expect(() => localAgentEnvironment(preset ?? { [LOCAL_AGENT_ENV_FD]: String(fd) })).toThrow();
  });
});
