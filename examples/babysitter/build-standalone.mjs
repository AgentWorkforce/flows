// Bundle the standalone Babysitter into one self-contained Cloud source:
// Cloud loads a flow from the request body and resolves no sibling imports.
// Policy is operator-owned and holds no credentials: deployed source is
// readable to its owner. Only the runtime-owned surface stays external.
import { build } from '../../packages/sdk/node_modules/esbuild/lib/main.js';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const [policyPath, ...extra] = process.argv.slice(2);
if (!policyPath || extra.length) throw new Error('Usage: node examples/babysitter/build-standalone.mjs <operator-policy.json>');
const policy = JSON.parse(await readFile(policyPath, 'utf8'));
const root = fileURLToPath(new URL('.', import.meta.url));
await mkdir(`${root}dist`, { recursive: true });
await build({
  stdin: {
    contents: `import { createStandaloneBabysitter } from './standalone.ts';\nexport default createStandaloneBabysitter(${JSON.stringify(policy)});\n`,
    resolveDir: root, sourcefile: 'standalone-entry.ts', loader: 'ts',
  },
  outfile: `${root}dist/babysitter-standalone.flow.ts`, bundle: true,
  platform: 'node', format: 'esm', target: 'node22', external: ['@relayflows/surface'],
  // readSignals/postComment/githubRead.toString() execute inside f.run; keep their identifiers.
  minify: false,
});
console.log('Built examples/babysitter/dist/babysitter-standalone.flow.ts. Run flows check before deployment.');
