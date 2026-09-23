// Embed operator-owned policy into a self-contained Cloud listener source.
// Do not put credentials in this policy: deployed source is readable to its owner.
import { build } from '../../packages/sdk/node_modules/esbuild/lib/main.js';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const [policyPath, ...extra] = process.argv.slice(2);
if (!policyPath || extra.length) throw new Error('Usage: node examples/babysitter/build-hosted.mjs <operator-policy.json>');
const policy = JSON.parse(await readFile(policyPath, 'utf8'));
const root = fileURLToPath(new URL('.', import.meta.url));
await mkdir(`${root}dist`, { recursive: true });
await build({
  stdin: {
    contents: `import { createHostedBabysitter } from './hosted.ts';\nexport default createHostedBabysitter(${JSON.stringify(policy)});\n`,
    resolveDir: root, sourcefile: 'hosted-entry.ts', loader: 'ts',
  },
  outfile: `${root}dist/babysitter-hosted.flow.ts`, bundle: true,
  platform: 'node', format: 'esm', target: 'node22', external: ['@relayflows/surface'],
  // githubRead.toString() executes inside f.run; keep its local identifiers.
  minify: false,
});
console.log('Built examples/babysitter/dist/babysitter-hosted.flow.ts. Run flows check before deployment.');
