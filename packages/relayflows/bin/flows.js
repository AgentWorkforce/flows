#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Not `import '@relayflows/sdk/dist/cli.js'`: that subpath isn't in the
// SDK's package "exports", so specifier resolution would refuse it. Locating
// the installed dependency's real CLI file directly sidesteps that — this
// package's only job is finding it and forwarding argv/stdio.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sdkCli = join(packageRoot, 'node_modules', '@relayflows', 'sdk', 'dist', 'cli.js');

if (!existsSync(sdkCli)) {
  process.stderr.write(
    `relayflows: could not find @relayflows/sdk at ${sdkCli}\n` +
      'Reinstall with `npm install -g relayflows`.\n',
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [sdkCli, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
