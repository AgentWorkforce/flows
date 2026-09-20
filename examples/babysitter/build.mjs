// Hosted submissions carry one source file. Bundle authored modules at release
// time, leaving only the runtime-owned surface import external.
import { build } from '../../packages/sdk/node_modules/esbuild/lib/main.js';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
await mkdir(`${root}dist`, { recursive: true });
await build({ entryPoints: [`${root}babysitter.flow.ts`], outfile: `${root}dist/babysitter.flow.ts`,
  bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['@relayflows/surface'],
  // githubRead.toString() is executed by f.run; preserve its local identifiers.
  minify: false,
});
console.log('Built examples/babysitter/dist/babysitter.flow.ts (generated, self-contained; platform effect blockers still apply).');
