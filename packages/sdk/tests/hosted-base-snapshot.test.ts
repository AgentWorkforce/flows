import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHostedBaseSnapshot,
  hostedBaseSourceDigest,
  removeHostedBaseSnapshot,
} from '../src/hosted-base-snapshot.js';
import { loadHostedExtensionRuntime } from '../src/hosted-extension-runtime.js';

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

  it('refuses an oversized source file before buffering its contents', async () => {
    const { project, flowPath } = fixture();
    const oversized = join(project, 'oversized.bin');
    writeFileSync(oversized, '');
    truncateSync(oversized, 64 * 1024 * 1024 + 1);
    await expect(createHostedBaseSnapshot(flowPath)).rejects.toMatchObject({
      code: 'plugin_source_invalid',
      message: expect.stringContaining('snapshot entry or byte limit'),
    });
  });

  it.each(['flows.json', 'flows.lock.json'])(
    'refuses oversized sparse %s before parsing it', async declaration => {
      const { project, flowPath } = fixture();
      const path = join(project, declaration);
      if (!existsSync(path)) writeFileSync(path, '');
      truncateSync(path, 1024 * 1024 + 1);
      await expect(loadHostedExtensionRuntime(flowPath)).rejects.toMatchObject({
        code: 'plugin_source_invalid',
        message: expect.stringContaining('bounded regular file'),
      });
    },
  );

  it('bounds a file that grows after its admitted size was checked', async () => {
    const { project } = fixture();
    const raced = join(project, 'raced.bin');
    writeFileSync(raced, 'small');
    await expect(hostedBaseSourceDigest([{ root: project, prefix: '' }], {
      afterStat: async path => {
        if (path === raced) truncateSync(raced, 64 * 1024 * 1024 + 1);
      },
    })).rejects.toMatchObject({
      code: 'plugin_source_invalid',
      message: expect.stringContaining('changed while reading "raced.bin"'),
    });
  });

  it.runIf(process.platform === 'linux' && existsSync('/usr/bin/mkfifo'))(
    'opens a substituted FIFO without blocking before rejecting it',
    async () => {
      const { project } = fixture();
      const raced = join(project, 'raced.txt');
      writeFileSync(raced, 'regular');
      let release: ReturnType<typeof setTimeout> | undefined;
      const started = Date.now();
      try {
        await expect(hostedBaseSourceDigest([{ root: project, prefix: '' }], {
          beforeOpen: async path => {
            if (path !== raced) return;
            rmSync(raced);
            const result = spawnSync('/usr/bin/mkfifo', [raced]);
            if (result.status !== 0) throw new Error(result.stderr.toString());
            // If O_NONBLOCK is removed, release the read-only open so the test
            // fails on elapsed time instead of hanging the test process.
            release = setTimeout(() => writeFileSync(raced, 'release'), 1_000);
          },
        })).rejects.toMatchObject({
          code: 'plugin_source_invalid',
          message: expect.stringContaining('unsupported entry "raced.txt"'),
        });
        expect(Date.now() - started).toBeLessThan(500);
      } finally {
        if (release !== undefined) clearTimeout(release);
      }
    },
  );

  it('stops streaming project entries at the shared count limit', async () => {
    const { project, flowPath } = fixture();
    for (let index = 0; index < 10_001; index += 1) {
      writeFileSync(join(project, `empty-${index}.txt`), '');
    }
    await expect(createHostedBaseSnapshot(flowPath)).rejects.toMatchObject({
      code: 'plugin_source_invalid',
      message: expect.stringContaining('snapshot entry or byte limit'),
    });
  });
});
