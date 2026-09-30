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

it.each([
  ['a renamed context', 'flow("x", async (ctx) => { ctx.on(source, { idle: "1h" }); })'],
  ['a destructured on', 'flow("x", { use: [] }, async ({ on: listen }) => { listen(source, { deadline: "1d" }); })'],
  ['a named body', 'async function body(context) { context.on(source, options); }\nexport default flow("x", body);'],
])('refuses an unbounded f.on through %s', async (_case, body) => {
  const directory = mkdtempSync(join(tmpdir(), 'flows-activity-check-'));
  directories.push(directory);
  const path = join(directory, 'renamed.flow.ts');
  writeFileSync(path, body);
  await expect(checkAuthoredActivities(path)).resolves.toMatchObject({
    report: { ok: false, diagnostics: [{ message: expect.stringContaining('unbounded_subscription') }] },
  });
});

it('ignores .on calls on values that are not a flow context', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'flows-activity-check-'));
  directories.push(directory);
  const path = join(directory, 'emitter.flow.ts');
  writeFileSync(path, 'function wire(emitter) { emitter.on("data", handler); }\n'
    + 'export default flow("x", async (ctx) => { ctx.on(source, { idle: "1h", deadline: "1d" }); });');
  await expect(checkAuthoredActivities(path)).resolves.toMatchObject({ report: { ok: true } });
});
