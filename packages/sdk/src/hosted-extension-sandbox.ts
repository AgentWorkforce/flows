import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { PluginError } from './plugin-manifest.js';
import { HOSTED_EXTENSION_SANDBOX_SOURCE } from './hosted-extension-sandbox-source.js';
import {
  exchangeHostedExtension,
  type HostedExtensionProtocolResult,
} from './hosted-extension-protocol.js';
import { materializePlugin, readStoredPluginFiles } from './plugin-store.js';

const HOSTED_WRITE = 'cloud:babysitter-turn';
const DEFAULT_TIMEOUT_MS = 10_000;
// These hard limits are inherited across prlimit -> bubblewrap -> Node and its
// descendants. RLIMIT_AS stays high enough for Node 22-26's large virtual V8
// and Wasm reservations; RLIMIT_DATA is the tighter bound on anonymous/native
// allocations (including Buffer mmap on supported Linux kernels). Together
// with 64 MiB old-space they refuse two hostile 2 GiB Buffers without preventing
// the pinned TypeScript handler from starting on supported Node releases.
const ADDRESS_SPACE_BYTES = 16 * 1024 * 1024 * 1024;
const DATA_BYTES = 3 * 1024 * 1024 * 1024;
const SURFACE_RUNTIME_SHA256 = Object.freeze({
  'flow.js': '4aaeacc55de3074f4d121ce7253c3be50a93757e6540ba8159889a9450d1c05c',
  'helpers/providers.js': '7bc62eccaa3a9e786ae0a689bf74160585149e91feef8208e17ef8eca51eed7f',
  'provider-trigger.js': 'e2664c65397f93fb486eb6f1e756c7cec3f88b3851d79c23567cad986f80f1ff',
  'schedule.js': '8fe72f176a75ec0b5f26e12db7a597575c259a2e2cbb59690f9dc20a5e63940b',
  'triggers.js': '4a3515b571a318f6c7a5661f9310bc9af43e3faf20ea39903a9b363c51258e4c',
  'triggers/github.js': 'e312994320f82aad0af00d09c504175d929cc6c601dfe1bc522632462ad9a48b',
});

export interface RunHostedExtensionSandboxOptions {
  readonly artifactDirectory: string;
  readonly artifactDigest: string;
  readonly entry: string;
  readonly surfaceVersion: string;
  readonly identity: { readonly provider: string; readonly event: string; readonly action?: string };
  readonly input: unknown;
  readonly invoke: (request: unknown) => Promise<unknown>;
  readonly timeoutMs?: number;
  readonly bubblewrapPath?: string;
  readonly nodePath?: string;
  readonly prlimitPath?: string;
  /** @internal Test seam for a package root with the exact pinned runtime bytes. */
  readonly surfaceRoot?: string;
  /** @internal Last parent-side authority check after private snapshots exist. */
  readonly beforeLaunch?: () => Promise<void>;
}

export async function runHostedExtensionSandbox(
  options: RunHostedExtensionSandboxOptions,
): Promise<HostedExtensionProtocolResult> {
  if (process.platform !== 'linux') return unsupported('hosted extension isolation requires Linux');
  if (options.nodePath === undefined && !supportsHostedSandboxFlags(process.versions.node)) {
    return unsupported(`hosted extension isolation does not support Node ${process.versions.node}`);
  }
  const bwrap = executable(options.bubblewrapPath ?? '/usr/bin/bwrap', 'bubblewrap');
  const prlimit = executable(options.prlimitPath ?? '/usr/bin/prlimit', 'prlimit');
  const node = executable(options.nodePath ?? process.execPath, 'Node');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    return unsupported('hosted extension timeout must be an integer from 1 to 60000ms');
  }
  const entryPath = resolve(options.artifactDirectory, options.entry);
  if (!entryPath.startsWith(`${resolve(options.artifactDirectory)}/`)) {
    throw new PluginError('plugin_path_invalid', `${options.entry}: hosted extension entry escapes its artifact.`);
  }
  const surfaceRoot = resolveSurfaceRoot(options.surfaceVersion, options.surfaceRoot);
  const runtimeDirectory = await mkdtemp(join(tmpdir(), 'flows-hosted-extension-'));
  const runner = join(runtimeDirectory, 'runner.mjs');
  const surfaceFacade = join(runtimeDirectory, 'surface');
  try {
    const storedFiles = await readStoredPluginFiles(options.artifactDirectory, options.artifactDigest);
    const snapshot = await materializePlugin(
      runtimeDirectory,
      'hosted-extension',
      storedFiles.filter(file => file.path !== 'manifest.json'),
    );
    if (snapshot.digest !== options.artifactDigest) {
      throw new PluginError(
        'plugin_source_drift',
        'Hosted extension changed while its isolated snapshot was created.',
      );
    }
    await writeFile(runner, HOSTED_EXTENSION_SANDBOX_SOURCE, { mode: 0o400, flag: 'wx' });
    await writeSurfaceFacade(surfaceFacade, surfaceRoot);
    const args = sandboxArguments({
      node,
      runner,
      extension: realpathSync(snapshot.directory),
      surfaceFacade,
    });
    await options.beforeLaunch?.();
    const child = spawn(prlimit, [
      `--as=${ADDRESS_SPACE_BYTES}`,
      `--data=${DATA_BYTES}`,
      '--', bwrap, ...args,
    ], {
      cwd: '/', env: {}, stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
    });
    return await exchangeHostedExtension(
      child,
      child.stdio[3] as Readable,
      child.stdin as Writable,
      child.stderr as Readable,
      timeoutMs,
      {
        type: 'execute',
        entry: `/extension/src/${options.entry}`,
        surfaceRuntime: '/extension/node_modules/@relayflows/surface/runtime.js',
        capability: HOSTED_WRITE,
        identity: options.identity,
        input: options.input,
      },
      options.invoke,
    );
  } finally {
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
}

function resolveSurfaceRoot(expectedVersion: string, override?: string): string {
  if (override !== undefined) return checkedSurfaceRoot(override, expectedVersion);
  let resolved: string;
  try { resolved = realpathSync(createRequire(import.meta.url).resolve('@relayflows/surface')); }
  catch { return unsupported('hosted extension cannot resolve @relayflows/surface'); }
  let directory = dirname(resolved);
  const root = parse(directory).root;
  while (directory !== root) {
    const packageJson = join(directory, 'package.json');
    if (existsSync(packageJson)) {
      try {
        const manifest = JSON.parse(readFileSync(packageJson, 'utf8')) as { name?: unknown; version?: unknown };
        if (manifest.name === '@relayflows/surface' && manifest.version === expectedVersion) {
          return realpathSync(directory);
        }
      } catch { /* keep walking */ }
    }
    directory = dirname(directory);
  }
  return unsupported('hosted extension resolved an invalid @relayflows/surface package');
}

function checkedSurfaceRoot(root: string, expectedVersion: string): string {
  let real: string;
  try { real = realpathSync(root); }
  catch { return unsupported('hosted extension cannot resolve @relayflows/surface'); }
  try {
    const manifest = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')) as {
      name?: unknown; version?: unknown;
    };
    if (manifest.name === '@relayflows/surface' && manifest.version === expectedVersion) return real;
  } catch { /* fall through */ }
  return unsupported('hosted extension resolved an invalid @relayflows/surface package');
}

async function writeSurfaceFacade(directory: string, surfaceRoot: string): Promise<void> {
  await Promise.all([
    mkdir(join(directory, 'dist/helpers'), { recursive: true }),
    mkdir(join(directory, 'dist/triggers'), { recursive: true }),
  ]);
  const runtimeFiles = Object.entries(SURFACE_RUNTIME_SHA256).map(([file, expected]) => {
    let bytes: Buffer;
    try { bytes = readFileSync(join(surfaceRoot, 'dist', file)); }
    catch { return unsupported(`hosted extension cannot read pinned Surface runtime ${file}`); }
    if (sha256(bytes) !== expected) {
      return unsupported(`hosted extension Surface runtime ${file} differs from the reviewed bytes`);
    }
    return { file, bytes, expected };
  });
  await Promise.all([
    writeFile(join(directory, 'package.json'), JSON.stringify({
      name: '@relayflows/surface', type: 'module', exports: { '.': './index.js', './runtime': './runtime.js' },
    }), { mode: 0o400, flag: 'wx' }),
    writeFile(join(directory, 'index.js'),
      "export { flow } from './dist/flow.js';\nexport { github } from './dist/triggers/github.js';\n",
      { mode: 0o400, flag: 'wx' }),
    writeFile(join(directory, 'runtime.js'), "export { getFlowDefinition } from './dist/flow.js';\n",
      { mode: 0o400, flag: 'wx' }),
    ...runtimeFiles.map(({ file, bytes }) => writeFile(join(directory, 'dist', file), bytes,
      { mode: 0o400, flag: 'wx' })),
  ]);
  for (const { file, expected } of runtimeFiles) {
    if (sha256(readFileSync(join(directory, 'dist', file))) !== expected) {
      throw new PluginError('plugin_source_drift', `Private Surface runtime snapshot changed at ${file}.`);
    }
  }
}

function sandboxArguments(input: {
  node: string; runner: string; extension: string; surfaceFacade: string;
}): string[] {
  const args = [
    '--unshare-all', '--die-with-parent', '--new-session', '--clearenv', '--cap-drop', 'ALL', '--dir', '/usr',
  ];
  for (const path of ['/usr/lib', '/usr/lib64', '/lib', '/lib64']) {
    if (existsSync(path)) args.push('--ro-bind', realpathSync(path), path);
  }
  args.push(
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--dir', '/runtime', '--ro-bind', input.node, '/runtime/node', '--ro-bind', input.runner, '/runtime/runner.mjs',
    '--dir', '/extension', '--dir', '/extension/node_modules', '--dir', '/extension/node_modules/@relayflows',
    '--dir', '/extension/node_modules/@relayflows/surface',
    '--ro-bind', join(input.surfaceFacade, 'package.json'), '/extension/node_modules/@relayflows/surface/package.json',
    '--ro-bind', join(input.surfaceFacade, 'index.js'), '/extension/node_modules/@relayflows/surface/index.js',
    '--ro-bind', join(input.surfaceFacade, 'runtime.js'), '/extension/node_modules/@relayflows/surface/runtime.js',
    '--dir', '/extension/node_modules/@relayflows/surface/dist',
    '--dir', '/extension/node_modules/@relayflows/surface/dist/helpers',
    '--dir', '/extension/node_modules/@relayflows/surface/dist/triggers',
    ...surfaceRuntimeMounts(input.surfaceFacade),
    '--ro-bind', input.extension, '/extension/src', '--chdir', '/extension/src',
    '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'PATH', '/runtime',
    '/runtime/node', '--permission', '--experimental-strip-types', '--max-old-space-size=64',
    '--allow-fs-read=/runtime', '--allow-fs-read=/extension', '/runtime/runner.mjs',
  );
  return args;
}

function surfaceRuntimeMounts(surfaceFacade: string): string[] {
  return Object.keys(SURFACE_RUNTIME_SHA256).flatMap(file => [
    '--ro-bind', realpathSync(join(surfaceFacade, 'dist', file)),
    `/extension/node_modules/@relayflows/surface/dist/${file}`,
  ]);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function executable(path: string, name: string): string {
  let real: string;
  try { real = realpathSync(path); }
  catch { return unsupported(`${name} is unavailable`); }
  if (!lstatSync(real).isFile()) return unsupported(`${name} is not a regular file`);
  return real;
}

export function supportsHostedSandboxFlags(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major >= 24 || (major === 23 && minor >= 5) || (major === 22 && minor >= 13);
}

function unsupported(message: string): never {
  throw new PluginError('plugin_unsupported', message);
}
