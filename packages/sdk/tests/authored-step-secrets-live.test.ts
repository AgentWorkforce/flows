import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { chainFixture } from './flow-chain-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

it('an authored shell child sees a delivered token only when its own f.run grants it', () => {
  const fixture = chainFixture();
  cleanup.push(() => fixture.close());
  writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
import { writeFileSync } from 'node:fs';
export default flow('scoped-shell', async f => {
  const plain = await f.run('printf %s "$NATIVE_API_TOKEN"');
  const granted = await f.run('printf %s "$NATIVE_API_TOKEN"', { secrets: ['NATIVE_API_TOKEN'] });
  writeFileSync('observed.json', JSON.stringify({ plain, granted }));
  f.done('success');
});
`);
  const previousToken = process.env.NATIVE_API_TOKEN;
  const previousManifest = process.env.RELAY_SECRET_ENV_NAMES;
  process.env.NATIVE_API_TOKEN = 'native-secret';
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
  expect(JSON.parse(readFileSync(`${fixture.root}/observed.json`, 'utf8')))
    .toEqual({ plain: '', granted: 'native-secret' });
}, 60_000);
