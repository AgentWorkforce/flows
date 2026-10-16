import { describe, expect, it } from 'vitest';
import { agentProbeEnvironment, agentStepEnvironment, validateStepSecrets } from '../src/step-secrets.js';
import { compileSpec, toKernelSpec } from '../src/compile.js';
import { agentEnvironment } from '../src/communication/environment.js';

const source = {
  PATH: '/usr/bin', HOME: '/tmp/home', LANG: 'C.UTF-8',
  CLAUDE_CODE_OAUTH_TOKEN: 'runtime-login',
  NATIVE_API_TOKEN: 'native-secret', OTHER_TOKEN: 'other-secret',
  GH_TOKEN: 'repository-grant',
  RELAY_SECRET_ENV_NAMES: JSON.stringify(['NATIVE_API_TOKEN', 'OTHER_TOKEN']),
};

describe('per-step secret grants', () => {
  it('records only grant names in compiled shell and agent steps', () => {
    const compiled = toKernelSpec(compileSpec({ version: '0.1.0', name: 'scoped', steps: [
      { id: 'call', type: 'deterministic', command: 'echo ok', secrets: ['NATIVE_API_TOKEN'] },
      { id: 'review', type: 'agent', instruction: 'review', cli: 'claude', secrets: ['OTHER_TOKEN'] },
    ] }));
    expect(compiled.steps.map(step => step.secrets)).toEqual([['NATIVE_API_TOKEN'], ['OTHER_TOKEN']]);
    expect(JSON.stringify(compiled)).not.toContain('native-secret');
  });
  it('gives an agent only its declared delivered secret, CLI login and repository grant', () => {
    const env = agentStepEnvironment(source, 'claude', ['NATIVE_API_TOKEN']);
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/tmp/home',
      CLAUDE_CODE_OAUTH_TOKEN: 'runtime-login', NATIVE_API_TOKEN: 'native-secret' });
    expect(env).not.toHaveProperty('OTHER_TOKEN');
    expect(env.GH_TOKEN).toBe('repository-grant');
    expect(env).not.toHaveProperty('RELAY_SECRET_ENV_NAMES');
  });

  it('starts undeclared agent steps without either delivered secret', () => {
    const env = agentStepEnvironment(source, 'claude');
    expect(env).not.toHaveProperty('NATIVE_API_TOKEN');
    expect(env).not.toHaveProperty('OTHER_TOKEN');
    expect(env.GH_TOKEN).toBe('repository-grant');
  });

  it('refuses unknown, duplicate, malformed and unavailable grants without values', () => {
    for (const declaration of [['GH_TOKEN'], ['MISSING'], ['NATIVE_API_TOKEN', 'NATIVE_API_TOKEN'],
      ['bad=name'], 'NATIVE_API_TOKEN', null]) {
      expect(() => validateStepSecrets(declaration, source)).toThrow();
    }
    expect(() => validateStepSecrets(['OTHER_TOKEN'], { ...source, OTHER_TOKEN: undefined })).toThrow();
  });

  it('fails closed on malformed delivered-name metadata', () => {
    expect(() => agentStepEnvironment({ ...source, RELAY_SECRET_ENV_NAMES: '{' }, 'claude')).toThrow();
  });

  it('never treats the private signal-read credential as a step grant', () => {
    const privateSource = { ...source, RELAY_SECRET_ENV_NAMES: undefined,
      RELAYFLOW_V2_SIGNAL_READ_TOKEN: 'private-signal-token' };
    expect(() => validateStepSecrets(['RELAYFLOW_V2_SIGNAL_READ_TOKEN'], privateSource)).toThrow();
    expect(agentStepEnvironment(privateSource, 'claude')).not.toHaveProperty('RELAYFLOW_V2_SIGNAL_READ_TOKEN');
  });

  it('keeps Cloud-selected Bedrock login while stripping another delivered secret', () => {
    const bedrock = {
      PATH: '/usr/bin', HOME: '/tmp/home',
      CLAUDE_CODE_USE_BEDROCK: '1', AWS_ACCESS_KEY_ID: 'bedrock-key',
      AWS_SECRET_ACCESS_KEY: 'bedrock-secret', AWS_SESSION_TOKEN: 'bedrock-session',
      AWS_REGION: 'eu-west-1', AWS_DEFAULT_REGION: 'eu-west-1',
      ANTHROPIC_API_KEY: 'user-provider-key', OTHER_TOKEN: 'user-secret',
      RELAY_SECRET_ENV_NAMES: JSON.stringify([
        'CLAUDE_CODE_USE_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
        'AWS_SESSION_TOKEN', 'ANTHROPIC_API_KEY', 'OTHER_TOKEN',
      ]),
      RELAY_PLATFORM_AGENT_ENV_NAMES: JSON.stringify([
        'CLAUDE_CODE_USE_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
        'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION',
      ]),
    };
    const env = agentStepEnvironment(bedrock, 'claude');
    expect(env).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_ACCESS_KEY_ID: 'bedrock-key',
      AWS_SECRET_ACCESS_KEY: 'bedrock-secret', AWS_SESSION_TOKEN: 'bedrock-session',
      AWS_REGION: 'eu-west-1', AWS_DEFAULT_REGION: 'eu-west-1' });
    expect(env).not.toHaveProperty('OTHER_TOKEN');
    expect(env.ANTHROPIC_API_KEY).toBe('user-provider-key');
    expect(env).not.toHaveProperty('RELAY_PLATFORM_AGENT_ENV_NAMES');
    expect(agentStepEnvironment(bedrock, 'codex')).not.toHaveProperty('AWS_ACCESS_KEY_ID');
  });

  it('keeps repository git/gh setup and hardening but strips a user secret', () => {
    const repository = {
      PATH: '/repo/bin:/usr/bin', HOME: '/tmp/home',
      GH_TOKEN: 'repo-grant', GH_CONFIG_DIR: '/tmp/gh', GH_PROMPT_DISABLED: '1',
      GITLAB_TOKEN: 'gitlab-proxy', GIT_ASKPASS: '/tmp/askpass',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '4', GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
      GIT_CONFIG_KEY_2: 'protocol.allow', GIT_CONFIG_VALUE_2: 'never',
      GIT_AUTHOR_NAME: 'Relayflow', GIT_AUTHOR_EMAIL: 'noreply@example.test',
      RELAYFLOW_V2_REPOSITORY_DIR: '/repo', RELAYFLOW_V2_REPOSITORY_JSON: '{}',
      RELAYFLOW_V2_GITLAB_API_URL: 'https://proxy.example.test',
      HTTPS_PROXY: 'https://proxy.example.test', NO_PROXY: 'localhost',
      USER_SECRET: 'user-secret', RELAY_SECRET_ENV_NAMES: '["USER_SECRET"]',
    };
    const env = agentStepEnvironment(repository, 'claude');
    for (const name of ['GH_TOKEN', 'GH_CONFIG_DIR', 'GH_PROMPT_DISABLED', 'GITLAB_TOKEN',
      'GIT_ASKPASS', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1', 'GIT_CONFIG_KEY_2', 'GIT_CONFIG_VALUE_2',
      'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'RELAYFLOW_V2_REPOSITORY_DIR',
      'RELAYFLOW_V2_REPOSITORY_JSON', 'RELAYFLOW_V2_GITLAB_API_URL', 'HTTPS_PROXY', 'NO_PROXY']) {
      expect(env[name], name).toBe(repository[name as keyof typeof repository]);
    }
    expect(env).not.toHaveProperty('USER_SECRET');
    const userToken = { ...repository, GH_TOKEN: 'user-gh-token',
      RELAY_SECRET_ENV_NAMES: '["USER_SECRET","GH_TOKEN"]' };
    expect(agentStepEnvironment(userToken, 'claude')).not.toHaveProperty('GH_TOKEN');
  });

  it('keeps only the selected CLI login and granted other secrets in every agent path', () => {
    const delivered = {
      ANTHROPIC_API_KEY: 'claude-login', OPENAI_API_KEY: 'codex-login',
      NATIVE_API_TOKEN: 'other-secret', GH_TOKEN: 'user-repository-secret',
      RELAY_SECRET_ENV_NAMES: JSON.stringify([
        'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NATIVE_API_TOKEN', 'GH_TOKEN',
      ]),
    };
    for (const [kind, own, foreign] of [
      ['claude', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
      ['codex', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    ] as const) {
      for (const env of [
        agentStepEnvironment(delivered, kind),
        agentProbeEnvironment(delivered, kind),
        agentEnvironment(kind, delivered),
        agentEnvironment(kind, delivered, undefined, false),
      ]) {
        expect(env[own]).toBe(delivered[own]);
        expect(env).not.toHaveProperty(foreign);
        expect(env).not.toHaveProperty('NATIVE_API_TOKEN');
        expect(env).not.toHaveProperty('GH_TOKEN');
      }
      for (const env of [
        agentStepEnvironment(delivered, kind, ['NATIVE_API_TOKEN']),
        agentProbeEnvironment(delivered, kind, ['NATIVE_API_TOKEN']),
        agentEnvironment(kind, delivered, ['NATIVE_API_TOKEN']),
      ]) {
        expect(env.NATIVE_API_TOKEN).toBe('other-secret');
      }
    }
    expect(agentStepEnvironment(delivered, 'relayflows-wrapper-v1')).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(agentProbeEnvironment(delivered, 'relayflows-wrapper-v1')).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('refuses a spoofed platform agent marker', () => {
    expect(() => agentStepEnvironment({ ...source,
      RELAY_PLATFORM_AGENT_ENV_NAMES: '["GH_TOKEN"]' }, 'claude')).toThrow();
    expect(() => agentStepEnvironment({ ...source,
      RELAY_PLATFORM_AGENT_ENV_NAMES: '{' }, 'claude')).toThrow();
  });
});
