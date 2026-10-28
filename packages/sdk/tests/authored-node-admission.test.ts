import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { parallelLoadedBodyEligible, parallelPinnedSourceEligible } from '../src/authored-parallel-eligibility.js';

const candidates = [
  ['TS1param', `async (f: any) => {
    await Promise.all([f.run('A'), f.run('B')]); f.done('success'); }`],
  ['TS2annot', `async f => { const w: string = await f.run('W');
    await Promise.all([f.run(w), f.run('B')]); f.done('success'); }`],
  ['TS3ret', `async f => {
    const a = async (): Promise<void> => { await f.run('A'); };
    const b = async (): Promise<void> => { await f.run('B'); };
    await Promise.all([a(), b()]); f.done('success'); }`],
];

// Use the real native importer, outside Vitest's TypeScript transform, to pin
// both loader outputs that npm admission must recognize by exact identity.
it.each(candidates)('certifies native Node imports of %s with and without transform-types', async (_name, candidate) => {
  const directory = mkdtempSync(join(tmpdir(), 'authored-node-admission-'));
  try {
    const path = join(directory, 'body.mts');
    writeFileSync(path, `export default ${candidate};`);
    const source = `import { flow } from '@relayflows/surface';\nexport default flow('typed', ${candidate});`;
    expect(parallelPinnedSourceEligible(source)).toBe(true);
    for (const flags of [[], ['--experimental-transform-types']]) {
      const child = spawnSync(process.execPath, [...flags, '--input-type=module', '-e',
        'const {default: body} = await import(process.argv[1]); console.log(Function.prototype.toString.call(body));',
        pathToFileURL(path).href], { encoding: 'utf8' });
      expect(child.status, child.stderr).toBe(0);
      const loaded = new Function(`return (${child.stdout});`)() as Function;
      const mode = flags.length === 0 ? 'strip' : 'transform';
      expect(await parallelLoadedBodyEligible(loaded, source, pathToFileURL(path).href, mode), flags.join(' ')).toBe(true);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
