import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runAgentCli } from '../src/worker-cli.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('a real agent child defaults to a clean env on a scoped runtime and sees only its grant', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flows-agent-secrets-'));
  roots.push(root);
  const observed = join(root, 'observed.json');
  const cli = join(root, 'claude');
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({
  native: process.env.NATIVE_API_TOKEN ?? null,
  other: process.env.OTHER_TOKEN ?? null,
  login: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
  grant: process.env.GH_TOKEN ?? null,
  signalRead: process.env.RELAYFLOW_V2_SIGNAL_READ_TOKEN ?? null,
  platformMarker: process.env.RELAY_PLATFORM_AGENT_ENV_NAMES ?? null,
}));
process.stdout.write(JSON.stringify({ type: 'result', result: 'echoed tok-0123456789abcdef',
  usage: { input_tokens: 2, output_tokens: 1 } }) + '\\n');
`);
  chmodSync(cli, 0o755);
  const source = {
    PATH: process.env.PATH, HOME: root, CLAUDE_CODE_OAUTH_TOKEN: 'cli-login',
    NATIVE_API_TOKEN: 'native-secret', OTHER_TOKEN: 'other-secret', GH_TOKEN: 'grant-token',
    FAKE_TOKEN: 'tok-0123456789abcdef',
    RELAYFLOW_V2_SIGNAL_READ_TOKEN: 'private-signal-token',
    RELAY_PLATFORM_AGENT_ENV_NAMES: '[]',
    RELAY_SECRET_ENV_NAMES: JSON.stringify(['NATIVE_API_TOKEN', 'OTHER_TOKEN', 'GH_TOKEN']),
  };
  const without = await runAgentCli(cli, 'task', undefined, undefined, undefined,
    undefined, 'agent', undefined, root, 'direct', undefined, source);
  expect(without.exit_code).toBe(0);
  expect(JSON.stringify(without.transcript)).toContain('[redacted:FAKE_TOKEN]');
  expect(JSON.stringify(without.transcript)).not.toContain('tok-0123456789abcdef');
  expect(JSON.parse(readFileSync(observed, 'utf8'))).toEqual({
    native: null, other: null, login: 'cli-login', grant: null, signalRead: null, platformMarker: null,
  });
  const withGrant = await runAgentCli(cli, 'task', undefined, undefined, undefined,
    undefined, 'agent', undefined, root, 'direct', undefined, source,
    undefined, undefined, undefined, ['NATIVE_API_TOKEN']);
  expect(withGrant.exit_code).toBe(0);
  expect(JSON.parse(readFileSync(observed, 'utf8'))).toEqual({
    native: 'native-secret', other: null, login: 'cli-login', grant: null, signalRead: null, platformMarker: null,
  });
  const legacy = await runAgentCli(cli, 'task', undefined, undefined, undefined,
    undefined, 'agent', undefined, root, 'direct', undefined, source,
    undefined, undefined, undefined, undefined, false);
  expect(legacy.exit_code).toBe(0);
  expect(JSON.parse(readFileSync(observed, 'utf8'))).toEqual({
    native: 'native-secret', other: 'other-secret', login: 'cli-login', grant: 'grant-token', signalRead: null, platformMarker: null,
  });
});
