import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkAuthoredActivities } from '../src/cli/check-activities.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it('refuses a body-level f.on without both required bounds', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'flows-activity-check-'));
  directories.push(directory);
  const path = join(directory, 'missing-bound.flow.ts');
  writeFileSync(path, 'export default async function body(f: unknown) { f.on(source, { idle: "1h" }); }');
  await expect(checkAuthoredActivities(path)).resolves.toMatchObject({
    report: { ok: false, diagnostics: [{ message: expect.stringContaining('unbounded_subscription') }] },
  });
});
