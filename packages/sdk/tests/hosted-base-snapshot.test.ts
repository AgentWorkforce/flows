import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHostedBaseSnapshot,
  hostedBaseSourceDigest,
  removeHostedBaseSnapshot,
} from '../src/hosted-base-snapshot.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const project = mkdtempSync(join(tmpdir(), 'hosted-base-snapshot-test-'));
  roots.push(project);
  writeFileSync(join(project, 'package.json'), '{"type":"module"}');
  writeFileSync(join(project, 'flows.json'), '{}');
  const flowPath = join(project, 'software-factory.flow.ts');
  const source = `throw new Error('tenant base must not execute');\n`;
  writeFileSync(flowPath, source);
  return { project, flowPath, source };
}

describe('hosted base private snapshot', () => {
  it('keeps the buffered base bytes when the live source changes', async () => {
    const { flowPath, source } = fixture();
    const snapshot = await createHostedBaseSnapshot(flowPath);
    try {
      writeFileSync(flowPath, `throw new Error('live replacement');\n`);
      expect(readFileSync(snapshot.snapshotFlowPath, 'utf8')).toBe(source);
      expect(await hostedBaseSourceDigest(snapshot.liveSources)).not.toBe(snapshot.liveDigest);
    } finally {
      await removeHostedBaseSnapshot(snapshot);
    }
  });

  it('excludes project node_modules from the admitted generation', async () => {
    const { project, flowPath } = fixture();
    const dependency = join(project, 'node_modules/local-identity');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, 'package.json'), '{"name":"local-identity"}');
    writeFileSync(join(dependency, 'index.js'), `throw new Error('must not execute');\n`);
    const snapshot = await createHostedBaseSnapshot(flowPath);
    try {
      expect(() => readFileSync(join(snapshot.snapshotRoot, 'node_modules/local-identity/index.js')))
        .toThrow();
      const before = await hostedBaseSourceDigest(snapshot.liveSources);
      writeFileSync(join(dependency, 'index.js'), `throw new Error('replacement');\n`);
      expect(await hostedBaseSourceDigest(snapshot.liveSources)).toBe(before);
    } finally {
      await removeHostedBaseSnapshot(snapshot);
    }
  });
});
