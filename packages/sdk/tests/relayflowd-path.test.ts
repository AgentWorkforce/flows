// Binary resolution, kernel/DAEMON-LIFECYCLE.md §3.1. Every anchor is driven
// through injected deps: nothing here touches a real filesystem or PATH.

import { describe, expect, it } from 'vitest';
import {
  RelayflowdNotFoundError,
  resolveRelayflowdBinary,
  runtimePackageName,
  type RelayflowdPathDeps,
} from '../src/relayflowd-path.js';

function makeDeps(overrides: Partial<RelayflowdPathDeps> = {}): RelayflowdPathDeps {
  return {
    env: {},
    entrypoint: undefined,
    cwd: '/workspace/project',
    moduleDir: '/workspace/project/node_modules/@relayflows/sdk/dist',
    platform: 'linux',
    arch: 'x64',
    isExecutable: () => false,
    exists: () => false,
    realpath: (path) => path,
    resolveFrom: () => null,
    which: () => null,
    ...overrides,
  };
}

describe('resolveRelayflowdBinary (§3.1)', () => {
  // Test 18. An operator who exported RELAYFLOWD_BIN meant it; falling through
  // to PATH would silently run a different binary than the one they named,
  // which is the silent fallback AGENTS.md rule 4 forbids.
  it('refuses a RELAYFLOWD_BIN that is not executable instead of falling through', () => {
    let whichCalls = 0;
    const deps = makeDeps({
      env: { RELAYFLOWD_BIN: '/etc/hosts' },
      which: () => {
        whichCalls += 1;
        return '/usr/local/bin/relayflowd';
      },
      isExecutable: (path) => path === '/usr/local/bin/relayflowd',
    });

    expect(() => resolveRelayflowdBinary(deps)).toThrow(RelayflowdNotFoundError);
    expect(() => resolveRelayflowdBinary(deps)).toThrow(/RELAYFLOWD_BIN/);
    expect(whichCalls).toBe(0);
  });

  it('honours an executable RELAYFLOWD_BIN above every other anchor', () => {
    const deps = makeDeps({
      env: { RELAYFLOWD_BIN: '/opt/custom/relayflowd' },
      isExecutable: () => true,
      entrypoint: '/usr/local/bin/flows',
    });
    expect(resolveRelayflowdBinary(deps)).toBe('/opt/custom/relayflowd');
  });

  // The published layout: bin/flows and bin/relayflowd side by side. realpath
  // matters because a package-manager launcher is a symlink into the real tree.
  it('finds the sibling of the resolved flows entrypoint', () => {
    const deps = makeDeps({
      entrypoint: '/usr/local/bin/flows',
      realpath: (path) => (path === '/usr/local/bin/flows'
        ? '/usr/local/lib/node_modules/@relayflows/runtime-linux-x64/bin/flows'
        : path),
      isExecutable: (path) =>
        path === '/usr/local/lib/node_modules/@relayflows/runtime-linux-x64/bin/relayflowd',
    });

    expect(resolveRelayflowdBinary(deps))
      .toBe('/usr/local/lib/node_modules/@relayflows/runtime-linux-x64/bin/relayflowd');
  });

  it('falls back to the per-host runtime package resolved from several anchors', () => {
    const seen: string[] = [];
    const deps = makeDeps({
      entrypoint: '/usr/local/bin/flows',
      realpath: (path) => path,
      resolveFrom: (specifier, anchor) => {
        seen.push(anchor);
        // Only the consumer's cwd can see the per-project optional dependency.
        return anchor === '/workspace/project/package.json'
          ? `/workspace/project/node_modules/${specifier}`
          : null;
      },
      isExecutable: (path) =>
        path === '/workspace/project/node_modules/@relayflows/runtime-linux-x64/bin/relayflowd',
    });

    expect(resolveRelayflowdBinary(deps))
      .toBe('/workspace/project/node_modules/@relayflows/runtime-linux-x64/bin/relayflowd');
    expect(seen).toContain('/workspace/project/package.json');
  });

  it('finds a source checkout by walking up to kernel/Cargo.toml', () => {
    const deps = makeDeps({
      cwd: '/src/flows/packages/sdk',
      exists: (path) => path === '/src/flows/kernel/Cargo.toml',
      isExecutable: (path) => path === '/src/flows/kernel/target/debug/relayflowd',
    });

    expect(resolveRelayflowdBinary(deps)).toBe('/src/flows/kernel/target/debug/relayflowd');
  });

  it('prefers a release build over a debug build in a source checkout', () => {
    const deps = makeDeps({
      cwd: '/src/flows',
      exists: (path) => path === '/src/flows/kernel/Cargo.toml',
      isExecutable: (path) => path.startsWith('/src/flows/kernel/target/'),
    });

    expect(resolveRelayflowdBinary(deps)).toBe('/src/flows/kernel/target/release/relayflowd');
  });

  it('uses PATH only when every anchored lookup came up empty', () => {
    const deps = makeDeps({
      which: () => '/usr/bin/relayflowd',
      isExecutable: (path) => path === '/usr/bin/relayflowd',
    });
    expect(resolveRelayflowdBinary(deps)).toBe('/usr/bin/relayflowd');
  });

  it('names the runtime package and the escape hatch when nothing is found', () => {
    expect(() => resolveRelayflowdBinary(makeDeps({ platform: 'darwin', arch: 'arm64' })))
      .toThrow(/@relayflows\/runtime-darwin-arm64.*RELAYFLOWD_BIN/s);
  });

  it('does not walk past a bounded number of ancestors', () => {
    const deps = makeDeps({
      cwd: '/a/b/c/d/e/f/g/h/i/j/deep',
      exists: (path) => path === '/kernel/Cargo.toml',
      isExecutable: () => true,
    });
    expect(() => resolveRelayflowdBinary(deps)).toThrow(RelayflowdNotFoundError);
  });

  it('names the package per platform and arch', () => {
    expect(runtimePackageName('linux', 'x64')).toBe('@relayflows/runtime-linux-x64');
    expect(runtimePackageName('darwin', 'arm64')).toBe('@relayflows/runtime-darwin-arm64');
  });
});
