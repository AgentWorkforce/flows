import { describe, expect, it } from 'vitest';
import { redact, redactRelayError } from '../src/redact.js';

const ENV: NodeJS.ProcessEnv = {
  GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  DB_PASSWORD: 'correct horse battery staple',
  SOME_CREDENTIAL: 'credential-material-1',
  OAUTH_CLIENT: 'oauth-client-secret-value',
  AUTH_MODE: 'off',            // too short to be material
  RELAYFLOW_RUN_ID: '01M2369FGQYCC0WB7STBMZZGZM',
  RELAYFLOW_DATA_DIR: '/tmp/flows-data/.relayflowd',
  PATH: '/usr/bin:/bin',
};

describe('redact', () => {
  it('replaces the value of every secret-looking env var with its name', () => {
    const text = `token=${ENV['GITHUB_TOKEN']} aws=${ENV['AWS_SECRET_ACCESS_KEY']} pw=${ENV['DB_PASSWORD']} `
      + `cred=${ENV['SOME_CREDENTIAL']} oauth=${ENV['OAUTH_CLIENT']}`;
    expect(redact(text, ENV)).toBe(
      'token=[redacted:GITHUB_TOKEN] aws=[redacted:AWS_SECRET_ACCESS_KEY] pw=[redacted:DB_PASSWORD] '
      + 'cred=[redacted:SOME_CREDENTIAL] oauth=[redacted:OAUTH_CLIENT]',
    );
  });

  it('leaves short values, identifiers, paths and env names alone', () => {
    const text = `AUTH_MODE=${ENV['AUTH_MODE']} run ${ENV['RELAYFLOW_RUN_ID']} in ${ENV['RELAYFLOW_DATA_DIR']} `
      + 'names: GITHUB_TOKEN AWS_SECRET_ACCESS_KEY step analyze-2 hash 3123e1cd26ab8297';
    // `AUTH_MODE` matches the secret-name pattern but `off` is under the
    // length floor, and `_MODE=` is not an assignment shape the scrub targets.
    expect(redact(text, ENV)).toBe(
      'AUTH_MODE=off run 01M2369FGQYCC0WB7STBMZZGZM in /tmp/flows-data/.relayflowd '
      + 'names: GITHUB_TOKEN AWS_SECRET_ACCESS_KEY step analyze-2 hash 3123e1cd26ab8297',
    );
  });

  it.each([
    ['relay token', 'key rk_live_abc123DEF', 'key [redacted]'],
    ['observer token', 'see ot_live_xyz-9', 'see [redacted]'],
    ['agent token', 'at_0123456789', '[redacted]'],
    ['bearer', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x.y', 'Authorization: Bearer [redacted]'],
    ['authorization header', 'authorization: Basic dXNlcjpwYXNz', 'authorization: Basic [redacted]'],
    ['authorization header, no scheme', 'authorization: dXNlcjpwYXNz', 'authorization: [redacted]'],
    ['callback token header', 'X-Callback-Token: cbt-123456 ok', 'X-Callback-Token: [redacted] ok'],
    ['evidence token header', 'x-nightcto-evidence-token: ev-abcdef', 'x-nightcto-evidence-token: [redacted]'],
    ['openai-style key', 'sk-abcdefghijklmnop1234 rest', '[redacted] rest'],
    ['github pat', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12', '[redacted]'],
    ['slack token', 'xoxb-1234-5678-abcd', '[redacted]'],
    ['assignment', 'export MY_API_KEY=abc123 and PASSWORD=hunter2', 'export MY_API_KEY=[redacted] and PASSWORD=[redacted]'],
    ['assignment keeps unrelated', 'FOO=bar STEP_ID=analyze', 'FOO=bar STEP_ID=analyze'],
  ])('scrubs the %s shape', (_label, input, expected) => {
    expect(redact(input, {})).toBe(expected);
  });

  it('replaces a longer secret before a shorter one it contains', () => {
    const env = { A_TOKEN: 'abcdefgh', B_TOKEN: 'xxabcdefghxx' };
    expect(redact('xxabcdefghxx', env)).toBe('[redacted:B_TOKEN]');
  });
});

describe('redactRelayError', () => {
  it('keeps the historical spelling for the two relay names and the token pattern', () => {
    const env = { RELAY_AGENT_TOKEN: 'short', RELAY_API_KEY: 'rk_live_secretsecret' };
    // `short` is under the general length floor and still scrubbed here, as it always was.
    expect(redactRelayError('short rk_live_secretsecret nt_x', env)).toBe('[redacted] [redacted] [redacted]');
  });

  it('additionally applies the general scrub', () => {
    expect(redactRelayError('Bearer abc GITHUB_TOKEN=zzz', {})).toBe('Bearer [redacted] GITHUB_TOKEN=[redacted]');
  });
});

// --- review finding on flows#492: quoted JSON credential fields -------------

describe('redact — JSON credential fields', () => {
  it('redacts an opaque quoted value the environment does not carry', () => {
    // No vendor token shape, and the value was never exported, so every other
    // rule left `{"authToken":"opaque-secret"}` intact.
    expect(redact('{"authToken":"opaque-secret"}', {})).toBe('{"authToken":"[redacted]"}');
  });

  for (const [name, value] of [
    ['token', 'abcdefgh'],
    ['authorization', 'Basic zzzzzzzz'],
    ['api_key', 'xyz12345'],
    ['refresh_token', 'rrrrrrrr'],
    ['sessionCookie', 'cccccccc'],
    ['X-Callback-Token', 'aaaabbbb'],
    ['PASSWORD', 'hunter22'],
  ] as const) {
    it(`redacts "${name}"`, () => {
      expect(redact(`{"${name}":"${value}"}`, {})).toBe(`{"${name}":"[redacted]"}`);
    });
  }

  for (const name of ['monkey', 'keyboard', 'donkey', 'name', 'turkey']) {
    it(`leaves "${name}" alone — containing a credential noun is not being one`, () => {
      const text = `{"${name}":"banana-time"}`;
      expect(redact(text, {})).toBe(text);
    });
  }

  it('leaves non-string and short values alone', () => {
    expect(redact('{"tokens":3}', {})).toBe('{"tokens":3}');
    expect(redact('{"AUTH_MODE":"off"}', {})).toBe('{"AUTH_MODE":"off"}');
  });

  it('redacts one field without disturbing its neighbours', () => {
    expect(redact('{"a":"keep this","secret":"ssssssss","b":"keep too"}', {}))
      .toBe('{"a":"keep this","secret":"[redacted]","b":"keep too"}');
  });

  it('does not re-redact an already redacted value', () => {
    expect(redact('{"token":"[redacted]"}', {})).toBe('{"token":"[redacted]"}');
  });
});
