import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { JournalClient } from '../src/journal-client.js';
import { socketPathFor } from '../src/daemon-connection.js';
import { readAuthoredRootMetadata } from '../src/authored-root.js';
import { chainFixture } from './flow-chain-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

it('an authored shell child sees a delivered token only when its own f.run grants it', () => {
  const fixture = chainFixture();
  cleanup.push(() => fixture.close());
  writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
import { writeFileSync } from 'node:fs';
export default flow('scoped-shell', async f => {
  const plain = await f.run('printf "%s:%s" "$NATIVE_API_TOKEN" "$RELAYFLOW_V2_SIGNAL_READ_TOKEN"');
  const granted = await f.run('printf %s "$NATIVE_API_TOKEN"', { secrets: ['NATIVE_API_TOKEN'] });
  writeFileSync('observed.json', JSON.stringify({ plain, granted }));
  f.done('success');
});
`);
  const previousToken = process.env.NATIVE_API_TOKEN;
  const previousManifest = process.env.RELAY_SECRET_ENV_NAMES;
  const previousPrivate = process.env.RELAYFLOW_V2_SIGNAL_READ_TOKEN;
  process.env.NATIVE_API_TOKEN = 'native-secret';
  process.env.RELAY_SECRET_ENV_NAMES = '["NATIVE_API_TOKEN"]';
  process.env.RELAYFLOW_V2_SIGNAL_READ_TOKEN = 'private-signal-token';
  let result;
  try {
    result = fixture.invoke('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
      fixture.flowPath, '--input', '{}');
  } finally {
    if (previousToken === undefined) delete process.env.NATIVE_API_TOKEN;
    else process.env.NATIVE_API_TOKEN = previousToken;
    if (previousManifest === undefined) delete process.env.RELAY_SECRET_ENV_NAMES;
    else process.env.RELAY_SECRET_ENV_NAMES = previousManifest;
    if (previousPrivate === undefined) delete process.env.RELAYFLOW_V2_SIGNAL_READ_TOKEN;
    else process.env.RELAYFLOW_V2_SIGNAL_READ_TOKEN = previousPrivate;
  }
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(JSON.parse(readFileSync(`${fixture.root}/observed.json`, 'utf8')))
    .toEqual({ plain: ':', granted: 'native-secret' });
}, 60_000);

it('parallel authored shell children keep their own secret grants', async () => {
  const fixture = chainFixture();
  cleanup.push(() => fixture.close());
  writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('parallel-scoped-shell', async f => {
  const outputs = await Promise.all([
    f.run('printf %s "$NATIVE_API_TOKEN"'),
    f.run('printf %s "$NATIVE_API_TOKEN"', { secrets: ['NATIVE_API_TOKEN'] }),
  ]);
  await f.run('printf "%s:%s" "' + outputs[0] + '" "' + outputs[1] + '" > observed.txt');
  f.done('success');
});
`);
  const previousToken = process.env.NATIVE_API_TOKEN;
  const previousManifest = process.env.RELAY_SECRET_ENV_NAMES;
  process.env.NATIVE_API_TOKEN = 'parallel-secret';
  process.env.RELAY_SECRET_ENV_NAMES = '["NATIVE_API_TOKEN"]';
  let result;
  try {
    result = fixture.invoke('run', '--no-observer-link', '--json', '--data-dir', fixture.data,
      fixture.flowPath, '--input', '{}');
  } finally {
    if (previousToken === undefined) delete process.env.NATIVE_API_TOKEN;
    else process.env.NATIVE_API_TOKEN = previousToken;
    if (previousManifest === undefined) delete process.env.RELAY_SECRET_ENV_NAMES;
    else process.env.RELAY_SECRET_ENV_NAMES = previousManifest;
  }
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(readFileSync(`${fixture.root}/observed.txt`, 'utf8')).toBe(':parallel-secret');
  const rootRunId = readdirSync(`${fixture.data}/runs`).find(name => name.endsWith('.sqlite3'))!
    .slice(0, -'.sqlite3'.length);
  const reader = new JournalClient(socketPathFor(fixture.data));
  await reader.connect();
  await reader.hello('parallel-secret-mode-test');
  try {
    expect(await readAuthoredRootMetadata(reader, rootRunId))
      .toMatchObject({ executionMode: 'parallel' });
  } finally { reader.close(); }
}, 60_000);
