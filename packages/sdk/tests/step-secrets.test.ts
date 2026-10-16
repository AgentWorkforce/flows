import { describe, expect, it } from 'vitest';
import { agentStepEnvironment, validateStepSecrets } from '../src/step-secrets.js';
import { compileSpec, toKernelSpec } from '../src/compile.js';

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
  it('gives an agent only the secret it declared, plus its own CLI login', () => {
    const env = agentStepEnvironment(source, 'claude', ['NATIVE_API_TOKEN']);
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/tmp/home',
      CLAUDE_CODE_OAUTH_TOKEN: 'runtime-login', NATIVE_API_TOKEN: 'native-secret' });
    expect(env).not.toHaveProperty('OTHER_TOKEN');
    expect(env).not.toHaveProperty('GH_TOKEN');
    expect(env).not.toHaveProperty('RELAY_SECRET_ENV_NAMES');
  });

  it('starts undeclared agent steps without either delivered secret', () => {
    const env = agentStepEnvironment(source, 'claude');
    expect(env).not.toHaveProperty('NATIVE_API_TOKEN');
    expect(env).not.toHaveProperty('OTHER_TOKEN');
    expect(env).not.toHaveProperty('GH_TOKEN');
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
});
