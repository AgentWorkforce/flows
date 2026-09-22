// Produce the one-file artifact consumed by the public Recommended Flow catalog.
// Cloud fetches exactly one immutable source blob, so authored modules are
// bundled while the runtime-owned Surface package remains external.
import { build } from '../../packages/sdk/node_modules/esbuild/lib/main.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const check = process.argv.slice(2).includes('--check');
const root = fileURLToPath(new URL('.', import.meta.url));
const outfile = `${root}dist/babysitter-recommended.flow.ts`;
const result = await build({
  entryPoints: [`${root}recommended.ts`],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@relayflows/surface'],
  minify: false,
  write: false,
});
const generated = new TextDecoder().decode(result.outputFiles[0].contents);

if (check) {
  const committed = await readFile(outfile, 'utf8').catch(() => '');
  if (committed !== generated) {
    throw new Error('dist/babysitter-recommended.flow.ts is stale; run npm run build:recommended');
  }
  console.log('Checked dist/babysitter-recommended.flow.ts');
} else {
  await mkdir(`${root}dist`, { recursive: true });
  await writeFile(outfile, generated);
  console.log('Built examples/babysitter/dist/babysitter-recommended.flow.ts');
}
