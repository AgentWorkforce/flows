import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generate, referencePaths } from './generate-authoring-reference.mjs';
import { root } from './authoring-source.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--docs-dir')) throw new Error('Usage: check-authoring-reference.mjs [--docs-dir <directory>]');
const actualRoot = resolve(args[1] ?? root);
const temporary = mkdtempSync(join(tmpdir(), 'authoring-reference-'));
try {
  generate(temporary);
  const drifted = referencePaths.filter(file => {
    try { return !readFileSync(join(temporary, file)).equals(readFileSync(join(actualRoot, file))); }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  });
  if (drifted.length) throw new Error(`Authoring reference drifted: ${drifted.join(', ')}. Run npm run gen:docs --prefix packages/surface`);
  console.log('AUTHORING_REFERENCE_OK');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
