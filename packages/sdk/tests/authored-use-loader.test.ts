import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAuthoredFlow } from '../src/authored-flow-loader.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(files: Record<string, string[]>): string {
  const directory = mkdtempSync(join(tmpdir(), 'flows-use-'));
  directories.push(directory);
  mkdirSync(join(directory, 'node_modules', '@relayflows'), { recursive: true });
  symlinkSync(resolve('node_modules/@relayflows/surface'), join(directory, 'node_modules/@relayflows/surface'));
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  for (const [name, use] of Object.entries(files)) {
    writeFileSync(join(directory, `${name}.flow.ts`), `
      import { flow } from '@relayflows/surface';
      export default flow(${JSON.stringify(name)}, { use: ${JSON.stringify(use)} }, async f => {
        throw new Error('loader must never execute authored bodies');
      });
    `);
  }
  return directory;
}

describe('authored use graph loader', () => {
  it('loads a diamond in dependency order with one node per canonical path', async () => {
    const directory = fixture({
      root: ['./mid1.flow.ts', './mid2.flow.ts'],
      mid1: ['./leaf.flow.ts'], mid2: ['./leaf.flow.ts'], leaf: [],
    });
    const loaded = await loadAuthoredFlow(join(directory, 'root.flow.ts'));
    expect(loaded.graph.map(node => node.handle.name)).toEqual(['leaf', 'mid1', 'mid2', 'root']);
    expect(loaded.graph[1]?.use).toEqual(loaded.graph[2]?.use);
    expect(Object.isFrozen(loaded.graph)).toBe(true);
  });

  it('refuses a transitive use cycle before executing any body', async () => {
    const directory = fixture({ a: ['./b.flow.ts'], b: ['./a.flow.ts'] });
    await expect(loadAuthoredFlow(join(directory, 'a.flow.ts'))).rejects.toMatchObject({ kind: 'use_cycle' });
  });

  it('refuses a missing declared flow', async () => {
    const directory = fixture({ root: ['./missing.flow.ts'] });
    await expect(loadAuthoredFlow(join(directory, 'root.flow.ts'))).rejects.toMatchObject({ kind: 'use_not_found' });
  });

  it.each([
    'throw new Error("import failed");',
    'export default { name: "forged" };',
  ])('refuses a declared module that cannot supply a flow: %s', async source => {
    const directory = fixture({ root: ['./invalid.flow.ts'] });
    writeFileSync(join(directory, 'invalid.flow.ts'), source);
    await expect(loadAuthoredFlow(join(directory, 'root.flow.ts'))).rejects.toMatchObject({ kind: 'use_invalid' });
  });
});
