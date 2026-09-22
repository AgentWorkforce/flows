import { createRequire } from 'node:module';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { sha256 } from './bundle.js';
import { PluginError } from './plugin-manifest.js';
import { HOSTED_EXTENSION_SANDBOX_SOURCE } from './hosted-extension-sandbox-source.js';
import {
  exchangeHostedExtension,
  type HostedExtensionProtocolResult,
} from './hosted-extension-protocol.js';
import { materializePlugin, readStoredPluginFiles } from './plugin-store.js';

const HOSTED_WRITE = 'cloud:babysitter-turn';
const CREATE_REQUIRE = createRequire;
const EXISTS_SYNC = existsSync;
const LSTAT_SYNC = lstatSync;
const READ_FILE_SYNC = readFileSync;
const REALPATH_SYNC = realpathSync;
const MKDIR = mkdir;
const MKDTEMP = mkdtemp;
const RM = rm;
const WRITE_FILE = writeFile;
const TMPDIR = tmpdir;
const PATH_DIRNAME = dirname;
const PATH_JOIN = join;
const PATH_PARSE = parse;
const PATH_RESOLVE = resolve;
const SPAWN = spawn;
const PROCESS_EXEC_PATH = process.execPath;
const PROCESS_NODE_VERSION = process.versions.node;
const PROCESS_PLATFORM = process.platform;
const PROMISE = Promise;
const EVENT_ON = Function.prototype.call.bind(EventEmitter.prototype.on) as (
  emitter: EventEmitter, event: string, listener: (...args: unknown[]) => void,
) => EventEmitter;
const CHILD_PROCESS_KILL = Function.prototype.call.bind(ChildProcess.prototype.kill) as (
  child: ChildProcess, signal?: NodeJS.Signals | number,
) => boolean;
const ARRAY_PUSH = Function.prototype.call.bind(Array.prototype.push) as <T>(array: T[], ...values: T[]) => number;
const JSON_PARSE = JSON.parse;
const JSON_STRINGIFY = JSON.stringify;
const OBJECT_ENTRIES = Object.entries;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_KEYS = Object.keys;
const STRING_STARTS_WITH = Function.prototype.call.bind(String.prototype.startsWith) as (
  value: string, search: string,
) => boolean;
const DEFAULT_TIMEOUT_MS = 10_000;
// These hard limits are inherited across prlimit -> bubblewrap -> Node and its
// descendants. RLIMIT_AS stays high enough for Node 22-26's large virtual V8
// and Wasm reservations; RLIMIT_DATA is the tighter bound on anonymous/native
// allocations (including Buffer mmap on supported Linux kernels). Together
// with 64 MiB old-space they refuse two hostile 2 GiB Buffers without preventing
// the pinned TypeScript handler from starting on supported Node releases.
const ADDRESS_SPACE_BYTES = 16 * 1024 * 1024 * 1024;
const DATA_BYTES = 3 * 1024 * 1024 * 1024;
const SURFACE_RUNTIME_SHA256 = OBJECT_FREEZE({
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
  if (PROCESS_PLATFORM !== 'linux') return unsupported('hosted extension isolation requires Linux');
  if (options.nodePath === undefined && !supportsHostedSandboxFlags(PROCESS_NODE_VERSION)) {
    return unsupported(`hosted extension isolation does not support Node ${PROCESS_NODE_VERSION}`);
  }
  const bwrap = executable(options.bubblewrapPath ?? '/usr/bin/bwrap', 'bubblewrap');
  const prlimit = executable(options.prlimitPath ?? '/usr/bin/prlimit', 'prlimit');
  const node = executable(options.nodePath ?? PROCESS_EXEC_PATH, 'Node');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    return unsupported('hosted extension timeout must be an integer from 1 to 60000ms');
  }
  const entryPath = PATH_RESOLVE(options.artifactDirectory, options.entry);
  if (!STRING_STARTS_WITH(entryPath, `${PATH_RESOLVE(options.artifactDirectory)}/`)) {
    throw new PluginError('plugin_path_invalid', `${options.entry}: hosted extension entry escapes its artifact.`);
  }
  const surfaceRoot = resolveSurfaceRoot(options.surfaceVersion, options.surfaceRoot);
  const runtimeDirectory = await MKDTEMP(PATH_JOIN(TMPDIR(), 'flows-hosted-extension-'));
  const runner = PATH_JOIN(runtimeDirectory, 'runner.mjs');
  const surfaceFacade = PATH_JOIN(runtimeDirectory, 'surface');
  try {
    const storedFiles = await readStoredPluginFiles(options.artifactDirectory, options.artifactDigest);
    const payloadFiles: { path: string; data: Buffer }[] = [];
    for (let index = 0; index < storedFiles.length; index += 1) {
      const file = storedFiles[index]!;
      if (file.path !== 'manifest.json') payloadFiles[payloadFiles.length] = file;
    }
    const snapshot = await materializePlugin(runtimeDirectory, 'hosted-extension', payloadFiles);
    if (snapshot.digest !== options.artifactDigest) {
      throw new PluginError(
        'plugin_source_drift',
        'Hosted extension changed while its isolated snapshot was created.',
      );
    }
    await WRITE_FILE(runner, HOSTED_EXTENSION_SANDBOX_SOURCE, { mode: 0o400, flag: 'wx' });
    await writeSurfaceFacade(surfaceFacade, surfaceRoot);
    const args = sandboxArguments({
      node,
      runner,
      extension: REALPATH_SYNC(snapshot.directory),
      surfaceFacade,
    });
    await options.beforeLaunch?.();
    const commandArgs = [`--as=${ADDRESS_SPACE_BYTES}`, `--data=${DATA_BYTES}`, '--', bwrap];
    for (let index = 0; index < args.length; index += 1) commandArgs[commandArgs.length] = args[index]!;
    const child = SPAWN(prlimit, commandArgs, {
      cwd: '/', env: {}, stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
    });
    const childClosed = child.exitCode !== null || child.signalCode !== null
      ? new PROMISE<void>(resolvePromise => resolvePromise())
      : new PROMISE<void>(resolvePromise => { EVENT_ON(child, 'close', () => resolvePromise()); });
    try {
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
      if (child.exitCode === null && child.signalCode === null) CHILD_PROCESS_KILL(child, 'SIGKILL');
      await childClosed;
    }
  } finally {
    await RM(runtimeDirectory, { recursive: true, force: true });
  }
}

function resolveSurfaceRoot(expectedVersion: string, override?: string): string {
  if (override !== undefined) return checkedSurfaceRoot(override, expectedVersion);
  let resolved: string;
  try { resolved = REALPATH_SYNC(CREATE_REQUIRE(import.meta.url).resolve('@relayflows/surface')); }
  catch { return unsupported('hosted extension cannot resolve @relayflows/surface'); }
  let directory = PATH_DIRNAME(resolved);
  const root = PATH_PARSE(directory).root;
  while (directory !== root) {
    const packageJson = PATH_JOIN(directory, 'package.json');
    if (EXISTS_SYNC(packageJson)) {
      try {
        const manifest = JSON_PARSE(READ_FILE_SYNC(packageJson, 'utf8')) as { name?: unknown; version?: unknown };
        if (manifest.name === '@relayflows/surface' && manifest.version === expectedVersion) {
          return REALPATH_SYNC(directory);
        }
      } catch { /* keep walking */ }
    }
    directory = PATH_DIRNAME(directory);
  }
  return unsupported('hosted extension resolved an invalid @relayflows/surface package');
}

function checkedSurfaceRoot(root: string, expectedVersion: string): string {
  let real: string;
  try { real = REALPATH_SYNC(root); }
  catch { return unsupported('hosted extension cannot resolve @relayflows/surface'); }
  try {
    const manifest = JSON_PARSE(READ_FILE_SYNC(PATH_JOIN(real, 'package.json'), 'utf8')) as {
      name?: unknown; version?: unknown;
    };
    if (manifest.name === '@relayflows/surface' && manifest.version === expectedVersion) return real;
  } catch { /* fall through */ }
  return unsupported('hosted extension resolved an invalid @relayflows/surface package');
}

async function writeSurfaceFacade(directory: string, surfaceRoot: string): Promise<void> {
  await MKDIR(PATH_JOIN(directory, 'dist/helpers'), { recursive: true });
  await MKDIR(PATH_JOIN(directory, 'dist/triggers'), { recursive: true });
  const entries = OBJECT_ENTRIES(SURFACE_RUNTIME_SHA256);
  const runtimeFiles: { file: string; bytes: Buffer; expected: string }[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const file = entries[index]![0];
    const expected = entries[index]![1];
    let bytes: Buffer;
    try { bytes = READ_FILE_SYNC(PATH_JOIN(surfaceRoot, 'dist', file)); }
    catch { return unsupported(`hosted extension cannot read pinned Surface runtime ${file}`); }
    if (sha256(bytes) !== expected) {
      return unsupported(`hosted extension Surface runtime ${file} differs from the reviewed bytes`);
    }
    runtimeFiles[index] = { file, bytes, expected };
  }
  await WRITE_FILE(PATH_JOIN(directory, 'package.json'), JSON_STRINGIFY({
    name: '@relayflows/surface', type: 'module', exports: { '.': './index.js', './runtime': './runtime.js' },
  }), { mode: 0o400, flag: 'wx' });
  await WRITE_FILE(PATH_JOIN(directory, 'index.js'),
    "export { flow } from './dist/flow.js';\nexport { github } from './dist/triggers/github.js';\n",
    { mode: 0o400, flag: 'wx' });
  await WRITE_FILE(PATH_JOIN(directory, 'runtime.js'), "export { getFlowDefinition } from './dist/flow.js';\n",
    { mode: 0o400, flag: 'wx' });
  for (let index = 0; index < runtimeFiles.length; index += 1) {
    const { file, bytes } = runtimeFiles[index]!;
    await WRITE_FILE(PATH_JOIN(directory, 'dist', file), bytes, { mode: 0o400, flag: 'wx' });
  }
  for (let index = 0; index < runtimeFiles.length; index += 1) {
    const { file, expected } = runtimeFiles[index]!;
    if (sha256(READ_FILE_SYNC(PATH_JOIN(directory, 'dist', file))) !== expected) {
      throw new PluginError('plugin_source_drift', `Private Surface runtime snapshot changed at ${file}.`);
    }
  }
}

/** @internal Pure construction seam for hostile-intrinsic regressions. */
export function sandboxArguments(input: {
  node: string; runner: string; extension: string; surfaceFacade: string;
}): string[] {
  const args = [
    '--unshare-all', '--die-with-parent', '--new-session', '--clearenv', '--cap-drop', 'ALL', '--dir', '/usr',
  ];
  const libraryPaths = ['/usr/lib', '/usr/lib64', '/lib', '/lib64'];
  for (let index = 0; index < libraryPaths.length; index += 1) {
    const path = libraryPaths[index]!;
    if (EXISTS_SYNC(path)) ARRAY_PUSH(args, '--ro-bind', REALPATH_SYNC(path), path);
  }
  ARRAY_PUSH(args,
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--dir', '/runtime', '--ro-bind', input.node, '/runtime/node', '--ro-bind', input.runner, '/runtime/runner.mjs',
    '--dir', '/extension', '--dir', '/extension/node_modules', '--dir', '/extension/node_modules/@relayflows',
    '--dir', '/extension/node_modules/@relayflows/surface',
    '--ro-bind', PATH_JOIN(input.surfaceFacade, 'package.json'), '/extension/node_modules/@relayflows/surface/package.json',
    '--ro-bind', PATH_JOIN(input.surfaceFacade, 'index.js'), '/extension/node_modules/@relayflows/surface/index.js',
    '--ro-bind', PATH_JOIN(input.surfaceFacade, 'runtime.js'), '/extension/node_modules/@relayflows/surface/runtime.js',
    '--dir', '/extension/node_modules/@relayflows/surface/dist',
    '--dir', '/extension/node_modules/@relayflows/surface/dist/helpers',
    '--dir', '/extension/node_modules/@relayflows/surface/dist/triggers',
  );
  const runtimeMounts = surfaceRuntimeMounts(input.surfaceFacade);
  for (let index = 0; index < runtimeMounts.length; index += 1) {
    args[args.length] = runtimeMounts[index]!;
  }
  ARRAY_PUSH(args,
    '--ro-bind', input.extension, '/extension/src', '--chdir', '/extension/src',
    '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'PATH', '/runtime',
    '/runtime/node', '--permission', '--experimental-strip-types', '--max-old-space-size=64',
    '--allow-fs-read=/runtime', '--allow-fs-read=/extension', '/runtime/runner.mjs',
  );
  return args;
}

function surfaceRuntimeMounts(surfaceFacade: string): string[] {
  const files = OBJECT_KEYS(SURFACE_RUNTIME_SHA256);
  const mounts: string[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    ARRAY_PUSH(
      mounts,
      '--ro-bind',
      REALPATH_SYNC(PATH_JOIN(surfaceFacade, 'dist', file)),
      `/extension/node_modules/@relayflows/surface/dist/${file}`,
    );
  }
  return mounts;
}


function executable(path: string, name: string): string {
  let real: string;
  try { real = REALPATH_SYNC(path); }
  catch { return unsupported(`${name} is unavailable`); }
  if (!LSTAT_SYNC(real).isFile()) return unsupported(`${name} is not a regular file`);
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
