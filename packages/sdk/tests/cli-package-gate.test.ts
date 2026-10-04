import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

const skip = process.env.FLOWS_SKIP_PACKAGE_GATE === '1';
if (skip) console.error('FLOWS_SKIP_PACKAGE_GATE=1: skipping network-dependent packed CLI installation test; packaging is unverified.');
it.skipIf(skip)('checks authored flows with locally and globally installed release tarballs', () => {
  execFileSync(process.execPath, ['scripts/cli-package-gate.mjs'], {
    cwd: fileURLToPath(new URL('../../..', import.meta.url)),
    stdio: 'inherit',
    timeout: 115_000,
  });
}, 120_000);
