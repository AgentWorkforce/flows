import { closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LOCAL_AGENT_ENV_FD, localAgentEnvironment } from '../src/local-agent-environment.js';

function payloadFd(value: string): number {
  const path = join(tmpdir(), `flows-agent-env-${randomUUID()}.json`);
  writeFileSync(path, value, { mode: 0o600 });
  const fd = openSync(path, 'r');
  unlinkSync(path);
  return fd;
}

describe('local agent environment', () => {
  it('merges descriptor values, removes the marker, and closes the descriptor', () => {
    const fd = payloadFd(JSON.stringify({ ANTHROPIC_API_KEY: 'house-key', SHARED: 'agent' }));
    const environment = localAgentEnvironment({ [LOCAL_AGENT_ENV_FD]: String(fd), SAFE: 'yes', SHARED: 'base' });
    expect(environment).toEqual({ SAFE: 'yes', SHARED: 'agent', ANTHROPIC_API_KEY: 'house-key' });
    expect(() => closeSync(fd)).toThrow();
  });

  it('returns a copy of an ordinary environment', () => {
    const base = { SAFE: 'yes' };
    const environment = localAgentEnvironment(base);
    expect(environment).toEqual(base);
    expect(environment).not.toBe(base);
  });

  it('removes the inherited descriptor capability from process.env', () => {
    const fd = payloadFd(JSON.stringify({ HOUSE_PROVIDER_KEY: 'secret' }));
    const prior = process.env[LOCAL_AGENT_ENV_FD];
    process.env[LOCAL_AGENT_ENV_FD] = String(fd);
    try {
      const environment = localAgentEnvironment();
      expect(environment.HOUSE_PROVIDER_KEY).toBe('secret');
      expect(environment[LOCAL_AGENT_ENV_FD]).toBeUndefined();
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
  ])('fails closed for %s', (_name, preset) => {
    const fd = preset === undefined
      ? payloadFd(_name === 'malformed JSON' ? '{' : JSON.stringify({ SECRET: 1 }))
      : undefined;
    expect(() => localAgentEnvironment(preset ?? { [LOCAL_AGENT_ENV_FD]: String(fd) })).toThrow();
  });
});
