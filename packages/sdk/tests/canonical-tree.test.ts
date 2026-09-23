import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { canonicalTree } from '../src/worker-cli.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// #554 (Cursor): the artifact lock compares canonical trees. A cwd that does
// not exist yet must still resolve through its existing ancestor's symlinks,
// or `/link/new` and `/link` compare as disjoint and are not serialized.
it('resolves a missing tail through the deepest existing ancestor', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'canonical-tree-'))); roots.push(root);
  const tree = join(root, 'tree');
  mkdirSync(tree);
  const link = join(root, 'link');
  symlinkSync(tree, link);

  expect(canonicalTree(link)).toBe(tree);
  const nested = canonicalTree(join(link, 'wt', 'not-yet'));
  expect(nested).toBe(join(tree, 'wt', 'not-yet'));
  // Nested under the resolved ancestor, so the lock sees the overlap.
  expect(nested.startsWith(canonicalTree(link) + sep)).toBe(true);
});
