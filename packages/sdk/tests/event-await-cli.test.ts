import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

it('parks, restarts, and replays two event wakes through the actual CLI', () => {
  const output = execFileSync(process.execPath, [resolve(here, 'fixtures/event-await-cli-probe.mjs'),
    resolve(here, '../../..')], { encoding: 'utf8', timeout: 90_000 });
  expect(output).toContain('E2E_PASS:');
}, 95_000);
