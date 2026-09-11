import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const generated = fileURLToPath(new URL('../src/helpers/', import.meta.url));
const generator = fileURLToPath(new URL('../../../scripts/generate-helpers.mjs', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'surface-helpers-'));
try {
  execFileSync(process.execPath, [generator, '--out-dir', temporary], { stdio: 'pipe' });
  const expected = readdirSync(temporary).sort();
  const actual = readdirSync(generated).filter(name => name.endsWith('.ts')).sort();
  const mismatch = new Set([...expected, ...actual].filter(name =>
    !expected.includes(name) || !actual.includes(name)
      || !readFileSync(join(temporary, name)).equals(readFileSync(join(generated, name)))));
  if (mismatch.size) throw new Error(`Generated helpers drifted: ${[...mismatch].join(', ')}. Run npm run gen --prefix packages/surface`);
  console.log(`HELPERS_GENERATED_OK ${expected.join(', ')}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
