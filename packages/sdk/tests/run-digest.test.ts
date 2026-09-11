import { afterEach, describe, expect, it } from 'vitest';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './deploy-fixture.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('digest run configuration refusals', () => {
  it.each(['{invalid json', '{"deploy":{}}', '{"deploy":{"bucket":123}}', '{"deploy":{"bucket":""}}'])(
    'reports config_invalid before fetching or starting a run for %s', async config => {
      const f = await fixture(); roots.push(f.root);
      await writeFile(join(f.root, 'flows.json'), config);
      const data = join(f.root, 'data');
      const result = f.invoke(['run', f.reference, '--data-dir', data, '--no-spawn', '--no-observer-link']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('[config_invalid]');
      expect(result.stderr).not.toContain('bundle_unsupported');
      await expect(readdir(join(f.root, 'cache'))).rejects.toThrow();
      await expect(readdir(data)).rejects.toThrow();
    },
  );
});
