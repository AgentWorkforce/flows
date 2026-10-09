import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { copyPrivateSurface } from './private-surface.mjs';

test('private Surface stays unchanged across shared build writes and cleanup', () => {
  const root = mkdtempSync(join(tmpdir(), 'private-surface-test-'));
  try {
    const source = join(root, 'source'), destination = join(root, 'private');
    mkdirSync(join(source, 'src'), { recursive: true });
    mkdirSync(join(source, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(source, 'package.json'), '{"name":"@relayflows/surface"}');
    writeFileSync(join(source, 'src', 'flow.ts'), 'original');
    writeFileSync(join(source, 'src', '.temporary.bun-build'), 'in progress');
    symlinkSync('missing', join(source, 'node_modules', '.bin', 'tool'));
    const link = join(root, 'surface-link');
    symlinkSync(source, link);
    copyPrivateSurface(link, destination);
    assert.deepEqual(readFileSync(join(destination, 'package.json')), readFileSync(join(source, 'package.json')));
    assert.throws(() => readFileSync(join(destination, 'src', '.temporary.bun-build')), { code: 'ENOENT' });
    assert.equal(lstatSync(join(destination, 'node_modules')).isSymbolicLink(), true);
    writeFileSync(join(source, 'src', 'flow.ts'), 'rebuilt');
    rmSync(source, { recursive: true });
    assert.equal(readFileSync(join(destination, 'src', 'flow.ts'), 'utf8'), 'original');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
