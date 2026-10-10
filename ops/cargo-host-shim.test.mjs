// Host cargo is usually a rustup shim. ops/cargo.sh must not point that shim
// at the private toolchain's RUSTUP_HOME before it has asked the shim whether
// it can run. An empty private rustup home makes the shim fail with
// "no default toolchain configured" even when the host toolchain is fine.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'cargo.sh');

function hostShim(root) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const cargo = join(bin, 'cargo');
  writeFileSync(cargo, [
    '#!/bin/sh',
    'if [ -n "${RUSTUP_HOME:-}" ] && [ ! -e "$RUSTUP_HOME/settings.toml" ]; then',
    '  echo "error: rustup could not choose a version: no default toolchain configured" >&2',
    '  exit 1',
    'fi',
    'if [ "$1" = "--version" ]; then',
    "  printf '%s\\n' 'cargo 1.99.0 (host shim)'",
    '  exit 0',
    'fi',
    'echo "unexpected $*" >&2',
    'exit 2',
    '',
  ].join('\n'));
  chmodSync(cargo, 0o755);
  return bin;
}

test('a host rustup shim still runs when the private rustup home is empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'cargo-host-shim-'));
  try {
    const env = { ...process.env };
    delete env.RUSTUP_HOME;
    delete env.CARGO_INSTALL_ROOT;
    env.PATH = `${hostShim(root)}:${env.PATH}`;
    env.HOME = join(root, 'home');
    env.RELAYFLOWS_TOOLCHAIN_HOME = join(root, 'toolchain');
    env.RELAYFLOWS_NO_TOOLCHAIN_INSTALL = '1';
    const result = spawnSync(script, ['--version'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^cargo 1\.99\.0 \(host shim\)\n$/);
    assert.doesNotMatch(result.stderr, /no default toolchain configured/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
