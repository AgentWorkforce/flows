import { describe, expect, it } from 'vitest';
import { openCredentialStart, openSecretStart, redact, redactRelayError } from '../src/redact.js';

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
    // Decision B: spare short identifiers such as at_ms.
    expect(redactRelayError('short rk_live_secretsecret nt_x', env)).toBe('[redacted] [redacted] nt_x');
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
      // Decision A: keep the auth scheme.
      const scheme = name === 'authorization' ? 'Basic ' : '';
      expect(redact(`{"${name}":"${value}"}`, {})).toBe(`{"${name}":"${scheme}[redacted]"}`);
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

  it('redacts an escaped value — a serialized key or nested JSON', () => {
    // The value class stopped at the first backslash, so every `\n` and `\"`
    // form — which is how a private key or a nested body actually arrives —
    // went through untouched.
    expect(redact(String.raw`{"token":"-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----"}`, {}))
      .toBe('{"token":"[redacted]"}');
    expect(redact(String.raw`{"authToken":"a\"b\"c"}`, {})).toBe('{"authToken":"[redacted]"}');
    // The near-miss name is still left alone, escapes or not.
    expect(redact(String.raw`{"monkey":"a\nb"}`, {})).toBe(String.raw`{"monkey":"a\nb"}`);
    // An escaped neighbour is not swallowed into the redacted span.
    expect(redact(String.raw`{"a":"x\ny","secret":"ssssssss"}`, {}))
      .toBe(String.raw`{"a":"x\ny","secret":"[redacted]"}`);
  });

  it('does not re-redact an already redacted value', () => {
    expect(redact('{"token":"[redacted]"}', {})).toBe('{"token":"[redacted]"}');
  });
});

describe('openSecretStart', () => {
  const PEM = '-----BEGIN PRIVATE KEY-----\nFAKE_KEY_MATERIAL_0123456789\n-----END PRIVATE KEY-----';
  const ENV_PEM: NodeJS.ProcessEnv = { SERVICE_PRIVATE_KEY: PEM };

  it('answers the length when nothing is half-arrived', () => {
    expect(openSecretStart('nothing to see here\n', ENV_PEM)).toBe(20);
    expect(openSecretStart('', ENV_PEM)).toBe(0);
    expect(openSecretStart(`already whole: ${PEM}\n`, ENV_PEM)).toBe(16 + PEM.length);
  });

  it('marks where a value has begun and not ended, across lines', () => {
    const head = 'dump:\n-----BEGIN PRIVATE KEY-----\n';
    expect(openSecretStart(head, ENV_PEM)).toBe(6);
    expect(openSecretStart(`dump:\n${PEM.slice(0, 3)}`, ENV_PEM)).toBe(6);
  });

  it('ignores a value no secret name exports, and one too short to be material', () => {
    expect(openSecretStart('dump:\n-----BEGIN PRIVATE KEY-----\n', {})).toBe(34);
    expect(openSecretStart('mode is of', { AUTH_MODE: 'off' })).toBe(10);
  });

  it('takes the earliest start when two secrets are open at once', () => {
    const env = { A_TOKEN: 'abcdefgh-longer-one', B_TOKEN: 'gh-longer-one-still' };
    // `abcdefgh-` opens at 4; `gh-longer-one-still` would open at 11.
    expect(openSecretStart('tailabcdefgh-', env)).toBe(4);
  });
});

describe('openCredentialStart', () => {
  it('answers the length when no credential context is open', () => {
    expect(openCredentialStart('plain log line\n')).toBe(15);
    expect(openCredentialStart('')).toBe(0);
    expect(openCredentialStart('authorization: Bearer tok\n')).toBe(26);
    expect(openCredentialStart('x-callback-token: tok\n')).toBe(22);
  });

  it.each([
    'x-callback-token:',
    'x-callback-token:\n',
    'x-callback-token:  \n',
    'x-nightcto-evidence-token:\n',
    'Bearer\n',
    'Bearer  \n\n',
    'authorization:',
    'authorization:\n',
    'authorization: Bearer\n',
    'authorization:\nBearer\n',
    'authorization: Bearer  \n',
  ])('marks a trailing %j header as open at the name', (tail) => {
    const text = `ok line\n${tail}`;
    expect(openCredentialStart(text)).toBe(8);
  });

  it('does not hold a header whose value already landed on its line', () => {
    // `authorization:Bearer` keeps `Bearer` held — a bare scheme word is an
    // open context anywhere — which is conservative, not wrong: whole-log
    // redaction would emit `authorization:[redacted]` either way.
    expect(openCredentialStart('authorization:Bearer\n')).toBe(14);
    expect(openCredentialStart('x-callback-token: opaque\n')).toBe(25);
    expect(openCredentialStart('Bearer opaque\n')).toBe(14);
    expect(openCredentialStart('authorization: Bearer opaque\nrest\n')).toBe(34);
  });

  it('marks an unterminated credential JSON field as open at the name', () => {
    expect(openCredentialStart('posting {"authToken": "opa')).toBe(9);
    expect(openCredentialStart('posting {"authToken":')).toBe(9);
    expect(openCredentialStart('posting {"authToken"')).toBe(9);
    expect(openCredentialStart('{"nested": {"password": "sec')).toBe(12);
  });

  it('does not hold closed, redacted, or non-credential JSON fields', () => {
    expect(openCredentialStart('{"authToken": "opaque"}\n')).toBe(24);
    expect(openCredentialStart('{"authToken": "[redacted]"}\n')).toBe(28);
    expect(openCredentialStart('{"authToken": 12')).toBe(16);
    expect(openCredentialStart('{"note": "unterminated')).toBe(22);
    expect(openCredentialStart('{"monkey": "tail')).toBe(16);
  });
});

describe('redaction', () => {
  const env: NodeJS.ProcessEnv = {
    FAKE_TOKEN: 'tok-0123456789abcdef',
    S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    // Harmless name, secret value: only the shape rule can catch a dump of it.
    DEPLOY_TARGET: 'hunter2-hunter2-hunter2',
    SHORT_KEY: 'abc',
    HOME: '/home/agent',
  };

  it('replaces the values of secret-named variables wherever they appear', () => {
    const text = `curl -H "x: ${env.FAKE_TOKEN}" and ${env.S3_SECRET_ACCESS_KEY} again ${env.FAKE_TOKEN}`;
    const out = redact(text, env);
    expect(out).toBe('curl -H "x: [redacted:FAKE_TOKEN]" and [redacted:S3_SECRET_ACCESS_KEY] again [redacted:FAKE_TOKEN]');
    // Too short to be worth matching by value: it would redact every "abc".
    expect(redact('abc abc', env)).toBe('abc abc');
  });

  it('redacts an env dump by shape whatever the variable is called', () => {
    const dump = `HOME=/home/agent\nDEPLOY_TARGET=${env.DEPLOY_TARGET}\nFAKE_TOKEN=${env.FAKE_TOKEN}\nOTHER=not-in-env\n`;
    expect(redact(dump, env)).toBe(
      'HOME=[redacted:HOME]\nDEPLOY_TARGET=[redacted:DEPLOY_TARGET]\nFAKE_TOKEN=[redacted:FAKE_TOKEN]\nOTHER=not-in-env\n');
  });

  it('redacts well-known token shapes, header values and private keys, keeping the names', () => {
    const cases: Array<[string, string]> = [
      ['key sk-ant-api03-abcdefghijklmnop', 'key [redacted]'],
      ['ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', '[redacted]'],
      ['github_pat_11ABCDEFG0123456789_abcdefghijklmnop', '[redacted]'],
      ['xoxb-1234567890-abcdefgh', '[redacted]'],
      ['AKIAIOSFODNN7EXAMPLE', '[redacted]'],
      ['at_live_abcdefghijklmnop', '[redacted]'],
      ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig', 'Authorization: Bearer [redacted]'],
      ['"authorization": "Bearer abcdefghijklmnop"', '"authorization": "Bearer [redacted]"'],
      ['x-api-key=abcdefghijklmnop', 'x-api-key=[redacted]'],
      ['x-callback-token: cb_abcdefghijklmnop', 'x-callback-token: [redacted]'],
      ['Cookie: session=abc; other=def', 'Cookie: [redacted]'],
      ['-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----', '[redacted:private-key]'],
    ];
    for (const [input, expected] of cases) expect(redact(input, env)).toBe(expected);
  });

  it('leaves journal keys that merely resemble a relay token prefix alone', () => {
    expect(redact('{"at_ms":1,"br_x":2}', env)).toBe('{"at_ms":1,"br_x":2}');
  });
});

describe('shared rule union', () => {
  it.each([
    ['github_pat_abcdefghijklmnop', '[redacted]'],
    ...['ghp', 'gho', 'ghs', 'ghu', 'ghr'].map(prefix => [`${prefix}_abcdefghijklmnop`, '[redacted]']),
    ['xoxs-abcdefgh', '[redacted]'],
    ['sk-ant-abcdefgh', '[redacted]'],
    ['set-cookie: sid=opaque; other=value', 'set-cookie: [redacted]'],
  ])('scrubs %s on the status path', (input, expected) => {
    expect(redact(input!, {})).toBe(expected);
  });

  it.each(['COOKIE', 'SESSION', 'PRIVATE'])('scrubs %s env values', name => {
    expect(redact('opaque-sensitive-value', { [name]: 'opaque-sensitive-value' })).toBe(`[redacted:${name}]`);
  });

  it('keeps short modes but redacts identifiers in matching env-dump lines', () => {
    expect(redact(`AUTH_MODE=off\nRELAYFLOW_RUN_ID=${ENV.RELAYFLOW_RUN_ID}`, ENV))
      .toBe('AUTH_MODE=off\nRELAYFLOW_RUN_ID=[redacted:RELAYFLOW_RUN_ID]');
    const source = 'let br_tag = ot_handle(at_index); for arr_item in arr_items: nt_count += 1';
    expect(redact(source, {})).toBe(source);
  });

  it.each(['authorization: Bearer', 'export MY_TOKEN=', 'Bearer', 'x-api-key:'])
  ('preserves JSON neighbours around %s', prefix => {
    const input = JSON.stringify({ log: `${prefix} abcdef1234`, step: 'a' });
    // Assignments do not permit whitespace after '='.
    const out = redact(input.replace('= ', '='), {});
    expect(JSON.parse(out)).toEqual({ log: `${prefix}${prefix.endsWith('=') ? '' : ' '}[redacted]`, step: 'a' });
  });

  it('preserves named replacements and auth schemes on repeated redaction', () => {
    const env = { API_TOKEN: 'opaque-sensitive-value' };
    const input = '{"authorization":"Bearer opaque-sensitive-value"}';
    const expected = '{"authorization":"Bearer [redacted:API_TOKEN]"}';
    expect(redact(input, env)).toBe(expected);
    expect(redact(expected, env)).toBe(expected);
  });

  it.each(['x-api-key:', 'cookie:', 'set-cookie:', 'x-api-key=', 'authorization=', 'cookie=', '"x-api-key":'])
  ('holds an open union header %s', head => {
    expect(openCredentialStart(`safe\n${head}\n`)).toBe(5);
  });

  it('holds an unexported PEM until its footer arrives', () => {
    const head = 'safe\n-----BEGIN RSA PRIVATE KEY-----\nmaterial\n';
    expect(openCredentialStart(head)).toBe(5);
    const complete = `${head}-----END RSA PRIVATE KEY-----\n`;
    expect(openCredentialStart(complete)).toBe(complete.length);
  });
});
