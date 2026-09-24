import { createRequire } from 'node:module';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Writable, type Readable } from 'node:stream';
import { payloadManifest, sha256 } from './bundle.js';
import {
  closeDescriptor,
  descriptorIsFile,
  openDescriptor,
  readDescriptor,
  statDescriptor,
} from './fs-descriptor.js';
import { snapshotJsonValue } from './json-value.js';
import { PluginError } from './plugin-manifest.js';
import {
  assertHostedPromiseSafety,
  frozenHostedPromiseValue,
  hostedPromiseValue,
} from './hosted-promise-safety.js';
import { appendIntrinsicArray } from './intrinsic-array.js';
import { HOSTED_EXTENSION_SANDBOX_SOURCE } from './hosted-extension-sandbox-source.js';
import {
  exchangeHostedExtension,
  type HostedExtensionProtocolResult,
} from './hosted-extension-protocol.js';
import { readStoredPluginFiles } from './plugin-store.js';

const HOSTED_WRITE = 'cloud:babysitter-turn';
const CREATE_REQUIRE = createRequire;
const CLOSE_SYNC = closeSync;
const EXISTS_SYNC = existsSync;
const FSTAT_SYNC = fstatSync;
const LSTAT_SYNC = lstatSync;
const OPEN_SYNC = openSync;
const READ_SYNC = readSync;
const REALPATH_SYNC = realpathSync;
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
const ARRAY_IS_ARRAY = Array.isArray;
const BUFFER_FROM = Buffer.from;
const BUFFER_ALLOC_UNSAFE = Buffer.allocUnsafe;
const BUFFER_TO_STRING = Function.prototype.call.bind(Buffer.prototype.toString) as (
  value: Buffer, encoding: BufferEncoding,
) => string;
const BIG_INT = BigInt;
const JSON_PARSE = JSON.parse;
const OBJECT_ENTRIES = Object.entries;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const NUMBER = Number;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const REGEXP_EXEC = Function.prototype.call.bind(RegExp.prototype.exec) as (
  regexp: RegExp, value: string,
) => RegExpExecArray | null;
const SET = Set;
const SET_ADD = Function.prototype.call.bind(Set.prototype.add) as <T>(set: Set<T>, value: T) => Set<T>;
const SET_HAS = Function.prototype.call.bind(Set.prototype.has) as <T>(set: Set<T>, value: T) => boolean;
const STRING = String;
const STRING_SPLIT = Function.prototype.call.bind(String.prototype.split) as (
  value: string, separator: string,
) => string[];
const STRING_STARTS_WITH = Function.prototype.call.bind(String.prototype.startsWith) as (
  value: string, search: string,
) => boolean;
const WRITABLE_END = Function.prototype.call.bind(Writable.prototype.end) as (
  stream: Writable,
) => Writable;
const WRITABLE_WRITE = Function.prototype.call.bind(Writable.prototype.write) as (
  stream: Writable, chunk: string | Uint8Array,
) => boolean;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_SURFACE_PACKAGE_BYTES = 64 * 1024;
const MAX_SURFACE_RUNTIME_BYTES = 512 * 1024;
const MAX_NODE_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const SURFACE_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const NODE_EXECUTABLE = captureNodeExecutable();
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
  'helpers/providers.js': '4eb06d0d85ca0a3434bb2dbba7407e3d95eef2dfbedaeb0e2de0c0c0ea812457',
  'provider-trigger.js': 'e2664c65397f93fb486eb6f1e756c7cec3f88b3851d79c23567cad986f80f1ff',
  'schedule.js': '8fe72f176a75ec0b5f26e12db7a597575c259a2e2cbb59690f9dc20a5e63940b',
  'triggers.js': '4a3515b571a318f6c7a5661f9310bc9af43e3faf20ea39903a9b363c51258e4c',
  'triggers/github.js': 'e312994320f82aad0af00d09c504175d929cc6c601dfe1bc522632462ad9a48b',
});
const SURFACE_PACKAGE_JSON = '{"name":"@relayflows/surface","type":"module","exports":{".":"./index.js","./runtime":"./runtime.js"}}';
const SURFACE_INDEX = "export { flow } from './dist/flow.js';\nexport { github } from './dist/triggers/github.js';\n";
const SURFACE_RUNTIME = "export { getFlowDefinition } from './dist/flow.js';\n";

interface SandboxDataFile {
  readonly destination: string;
  readonly bytes: Uint8Array;
}

export interface CapturedExecutable {
  readonly descriptor: number;
  readonly sha256: string;
  readonly stat: BigIntStats;
}

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
  assertHostedPromiseSafety('plugin_unsupported');
  if (PROCESS_PLATFORM !== 'linux') return unsupported('hosted extension isolation requires Linux');
  const nodeOverride = ownOption<string>(options, 'nodePath');
  if (nodeOverride === undefined && !supportsHostedSandboxFlags(PROCESS_NODE_VERSION)) {
    return unsupported(`hosted extension isolation does not support Node ${PROCESS_NODE_VERSION}`);
  }
  const bwrap = executable(ownOption<string>(options, 'bubblewrapPath') ?? '/usr/bin/bwrap', 'bubblewrap');
  const prlimit = executable(ownOption<string>(options, 'prlimitPath') ?? '/usr/bin/prlimit', 'prlimit');
  const nodeCapture = nodeOverride === undefined
    ? NODE_EXECUTABLE
    : captureExecutable(nodeOverride, 'Node');
  if (nodeCapture === undefined) return unsupported('Node is unavailable');
  let nodeBytes: Buffer;
  try { nodeBytes = readCapturedExecutable(nodeCapture, 'Node'); }
  finally { if (nodeOverride !== undefined) CLOSE_SYNC(nodeCapture.descriptor); }
  const timeoutMs = ownOption<number>(options, 'timeoutMs') ?? DEFAULT_TIMEOUT_MS;
  if (!NUMBER_IS_SAFE_INTEGER(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    return unsupported('hosted extension timeout must be an integer from 1 to 60000ms');
  }
  const entryPath = PATH_RESOLVE(options.artifactDirectory, options.entry);
  if (!STRING_STARTS_WITH(entryPath, `${PATH_RESOLVE(options.artifactDirectory)}/`)) {
    throw new PluginError('plugin_path_invalid', `${options.entry}: hosted extension entry escapes its artifact.`);
  }
  const surfaceRoot = await resolveSurfaceRoot(
    options.surfaceVersion,
    ownOption<string>(options, 'surfaceRoot'),
  );
  const storedFiles = await readStoredPluginFiles(options.artifactDirectory, options.artifactDigest);
  const payloadFiles: { path: string; data: Buffer }[] = [];
  for (let index = 0; index < storedFiles.length; index += 1) {
    const file = storedFiles[index]!;
    if (file.path !== 'manifest.json') appendIntrinsicArray(payloadFiles, file);
  }
  if (sha256(payloadManifest(payloadFiles)) !== options.artifactDigest) {
    throw new PluginError(
      'plugin_source_drift',
      'Hosted extension changed while its isolated snapshot was created.',
    );
  }
  const dataFiles: SandboxDataFile[] = [
    { destination: '/runtime/node', bytes: nodeBytes },
    { destination: '/runtime/runner.mjs', bytes: BUFFER_FROM(HOSTED_EXTENSION_SANDBOX_SOURCE) },
  ];
  const surfaceFiles = await readSurfaceFiles(surfaceRoot);
  for (let index = 0; index < surfaceFiles.length; index += 1) {
    appendIntrinsicArray(dataFiles, surfaceFiles[index]!);
  }
  for (let index = 0; index < payloadFiles.length; index += 1) {
    const file = payloadFiles[index]!;
    appendIntrinsicArray(dataFiles, {
      destination: `/extension/src/${file.path}`,
      bytes: file.data,
    });
  }
  const destinations: string[] = [];
  for (let index = 0; index < dataFiles.length; index += 1) {
    appendIntrinsicArray(destinations, dataFiles[index]!.destination);
  }
  const args = sandboxArguments({ dataDestinations: destinations });
  await ownOption<() => Promise<void>>(options, 'beforeLaunch')?.();
  const commandArgs = [`--as=${ADDRESS_SPACE_BYTES}`, `--data=${DATA_BYTES}`, '--', bwrap];
  for (let index = 0; index < args.length; index += 1) appendIntrinsicArray(commandArgs, args[index]!);
  const stdio: Array<'pipe' | 'ignore'> = ['pipe', 'ignore', 'pipe', 'pipe'];
  for (let index = 0; index < dataFiles.length; index += 1) appendIntrinsicArray(stdio, 'pipe');
  const child = SPAWN(prlimit, commandArgs, { cwd: '/', env: {}, stdio });
  for (let index = 0; index < dataFiles.length; index += 1) {
    const feed = child.stdio[index + 4] as Writable;
    EVENT_ON(feed as unknown as EventEmitter, 'error', () => undefined);
    WRITABLE_WRITE(feed, dataFiles[index]!.bytes);
    WRITABLE_END(feed);
  }
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
}

async function resolveSurfaceRoot(expectedVersion: string, override?: string): Promise<string> {
  if (override !== undefined) return await checkedSurfaceRoot(override, expectedVersion);
  let resolved: string;
  try { resolved = REALPATH_SYNC(CREATE_REQUIRE(import.meta.url).resolve('@relayflows/surface')); }
  catch { return unsupported('hosted extension cannot resolve @relayflows/surface'); }
  let directory = PATH_DIRNAME(resolved);
  const root = PATH_PARSE(directory).root;
  while (directory !== root) {
    const packageJson = PATH_JOIN(directory, 'package.json');
    if (EXISTS_SYNC(packageJson)) {
      try {
        const manifest = surfacePackageManifest(await readBoundedSurfaceFile(packageJson, MAX_SURFACE_PACKAGE_BYTES));
        if (manifest.name === '@relayflows/surface' && manifest.version === expectedVersion) {
          return REALPATH_SYNC(directory);
        }
      } catch { /* keep walking */ }
    }
    directory = PATH_DIRNAME(directory);
  }
  return unsupported('hosted extension resolved an invalid @relayflows/surface package');
}

async function checkedSurfaceRoot(root: string, expectedVersion: string): Promise<string> {
  let real: string;
  try { real = REALPATH_SYNC(root); }
  catch { return unsupported('hosted extension cannot resolve @relayflows/surface'); }
  try {
    const manifest = surfacePackageManifest(
      await readBoundedSurfaceFile(PATH_JOIN(real, 'package.json'), MAX_SURFACE_PACKAGE_BYTES),
    );
    if (manifest.name === '@relayflows/surface' && manifest.version === expectedVersion) return real;
  } catch { /* fall through */ }
  return unsupported('hosted extension resolved an invalid @relayflows/surface package');
}

async function readSurfaceFiles(surfaceRoot: string): Promise<readonly SandboxDataFile[]> {
  const entries = OBJECT_ENTRIES(SURFACE_RUNTIME_SHA256);
  const files: SandboxDataFile[] = [
    { destination: '/extension/node_modules/@relayflows/surface/package.json', bytes: BUFFER_FROM(SURFACE_PACKAGE_JSON) },
    { destination: '/extension/node_modules/@relayflows/surface/index.js', bytes: BUFFER_FROM(SURFACE_INDEX) },
    { destination: '/extension/node_modules/@relayflows/surface/runtime.js', bytes: BUFFER_FROM(SURFACE_RUNTIME) },
  ];
  for (let index = 0; index < entries.length; index += 1) {
    const file = entries[index]![0];
    const expected = entries[index]![1];
    let bytes: Buffer;
    try { bytes = await readBoundedSurfaceFile(PATH_JOIN(surfaceRoot, 'dist', file), MAX_SURFACE_RUNTIME_BYTES); }
    catch { return unsupported(`hosted extension cannot read pinned Surface runtime ${file}`); }
    if (sha256(bytes) !== expected) {
      return unsupported(`hosted extension Surface runtime ${file} differs from the reviewed bytes`);
    }
    appendIntrinsicArray(files, {
      destination: `/extension/node_modules/@relayflows/surface/dist/${file}`,
      bytes,
    });
  }
  return frozenHostedPromiseValue(files);
}

function surfacePackageManifest(bytes: Buffer): { readonly name?: unknown; readonly version?: unknown } {
  const value = snapshotJsonValue(JSON_PARSE(BUFFER_TO_STRING(bytes, 'utf8')), 'Surface package manifest', {
    maxBytes: MAX_SURFACE_PACKAGE_BYTES,
    maxDepth: 3,
    maxNodes: 64,
  });
  if (typeof value !== 'object' || value === null || ARRAY_IS_ARRAY(value)) {
    return unsupported('hosted extension resolved an invalid @relayflows/surface package');
  }
  return value as { readonly name?: unknown; readonly version?: unknown };
}

async function readBoundedSurfaceFile(path: string, maxBytes: number): Promise<Buffer> {
  const descriptor = await openDescriptor(path, SURFACE_READ_FLAGS);
  try {
    const before = await statDescriptor(descriptor, { bigint: true });
    if (!descriptorIsFile(before) || before.size < 0n || before.size > BIG_INT(maxBytes)) {
      return unsupported(`hosted extension cannot read bounded Surface file ${path}`);
    }
    const size = NUMBER(before.size);
    const bytes = BUFFER_ALLOC_UNSAFE(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = await readDescriptor(descriptor, bytes, offset, size - offset, offset);
      if (bytesRead === 0) return unsupported(`hosted extension Surface file ${path} changed while reading`);
      offset += bytesRead;
    }
    const extra = BUFFER_ALLOC_UNSAFE(1);
    if ((await readDescriptor(descriptor, extra, 0, 1, size)) !== 0) {
      return unsupported(`hosted extension Surface file ${path} changed while reading`);
    }
    const after = await statDescriptor(descriptor, { bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      return unsupported(`hosted extension Surface file ${path} changed while reading`);
    }
    return hostedPromiseValue(bytes);
  } finally {
    await closeDescriptor(descriptor);
  }
}

/** @internal Pure construction seam for hostile-intrinsic regressions. */
export function sandboxArguments(input: {
  dataDestinations: readonly string[];
}): string[] {
  const args = [
    '--unshare-all', '--die-with-parent', '--new-session', '--clearenv', '--cap-drop', 'ALL', '--dir', '/usr',
  ];
  const libraryPaths = ['/usr/lib', '/usr/lib64', '/lib', '/lib64'];
  for (let index = 0; index < libraryPaths.length; index += 1) {
    const path = libraryPaths[index]!;
    if (EXISTS_SYNC(path)) appendIntrinsicArray(args, '--ro-bind', REALPATH_SYNC(path), path);
  }
  appendIntrinsicArray(args,
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--dir', '/runtime',
    '--dir', '/extension', '--dir', '/extension/node_modules', '--dir', '/extension/node_modules/@relayflows',
    '--dir', '/extension/node_modules/@relayflows/surface',
    '--dir', '/extension/node_modules/@relayflows/surface/dist',
    '--dir', '/extension/node_modules/@relayflows/surface/dist/helpers',
    '--dir', '/extension/node_modules/@relayflows/surface/dist/triggers',
    '--dir', '/extension/src',
  );
  const directories = new SET<string>();
  const fixedDirectories = [
    '/runtime', '/extension', '/extension/node_modules', '/extension/node_modules/@relayflows',
    '/extension/node_modules/@relayflows/surface', '/extension/node_modules/@relayflows/surface/dist',
    '/extension/node_modules/@relayflows/surface/dist/helpers',
    '/extension/node_modules/@relayflows/surface/dist/triggers', '/extension/src',
  ];
  for (let index = 0; index < fixedDirectories.length; index += 1) {
    SET_ADD(directories, fixedDirectories[index]!);
  }
  for (let index = 0; index < input.dataDestinations.length; index += 1) {
    const parts = STRING_SPLIT(input.dataDestinations[index]!, '/');
    let directory = '';
    for (let partIndex = 1; partIndex < parts.length - 1; partIndex += 1) {
      directory += `/${parts[partIndex]!}`;
      if (!SET_HAS(directories, directory)) {
        SET_ADD(directories, directory);
        appendIntrinsicArray(args, '--dir', directory);
      }
    }
  }
  for (let index = 0; index < input.dataDestinations.length; index += 1) {
    const destination = input.dataDestinations[index]!;
    appendIntrinsicArray(
      args,
      '--perms', destination === '/runtime/node' ? '0500' : '0400',
      '--ro-bind-data', STRING(index + 4), destination,
    );
  }
  appendIntrinsicArray(args,
    '--chdir', '/extension/src',
    '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'PATH', '/runtime',
    '/runtime/node', '--permission', '--experimental-strip-types', '--max-old-space-size=64',
    '--allow-fs-read=/runtime', '--allow-fs-read=/extension', '/runtime/runner.mjs',
  );
  return args;
}

function captureNodeExecutable(): CapturedExecutable | undefined {
  try { return captureExecutable(PROCESS_EXEC_PATH, 'Node'); }
  catch { return undefined; }
}

/** @internal Descriptor-pinning seam for the executable replacement regression. */
export function captureExecutable(path: string, name: string): CapturedExecutable {
  let real: string;
  try { real = REALPATH_SYNC(path); }
  catch { return unsupported(`${name} is unavailable`); }
  let descriptor: number;
  try { descriptor = OPEN_SYNC(real, SURFACE_READ_FLAGS); }
  catch { return unsupported(`${name} is unavailable`); }
  try {
    const stat = FSTAT_SYNC(descriptor, { bigint: true });
    if (!descriptorIsFile(stat) || stat.size < 1n || stat.size > BIG_INT(MAX_NODE_EXECUTABLE_BYTES)) {
      return unsupported(`${name} is not a bounded regular file`);
    }
    const bytes = readExecutableDescriptor(descriptor, NUMBER(stat.size), name);
    const after = FSTAT_SYNC(descriptor, { bigint: true });
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
      || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) {
      return unsupported(`${name} changed while being captured`);
    }
    return OBJECT_FREEZE({ descriptor, sha256: sha256(bytes), stat });
  } catch (error) {
    CLOSE_SYNC(descriptor);
    throw error;
  }
}

/** @internal Reads the inode captured before authored code could replace its path. */
export function readCapturedExecutable(capture: CapturedExecutable, name: string): Buffer {
  const size = NUMBER(capture.stat.size);
  const bytes = readExecutableDescriptor(capture.descriptor, size, name);
  const after = FSTAT_SYNC(capture.descriptor, { bigint: true });
  if (after.dev !== capture.stat.dev || after.ino !== capture.stat.ino
    || after.size !== capture.stat.size || sha256(bytes) !== capture.sha256) {
    return unsupported(`${name} changed while reading`);
  }
  return bytes;
}

function readExecutableDescriptor(descriptor: number, size: number, name: string): Buffer {
  const bytes = BUFFER_ALLOC_UNSAFE(size);
  let offset = 0;
  while (offset < size) {
    const bytesRead = READ_SYNC(descriptor, bytes, offset, size - offset, offset);
    if (bytesRead === 0) return unsupported(`${name} changed while reading`);
    offset += bytesRead;
  }
  return bytes;
}


function executable(path: string, name: string): string {
  let real: string;
  try { real = REALPATH_SYNC(path); }
  catch { return unsupported(`${name} is unavailable`); }
  if (!descriptorIsFile(LSTAT_SYNC(real))) return unsupported(`${name} is not a regular file`);
  return real;
}

function ownOption<T>(options: object, name: string): T | undefined {
  const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(options, name);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value as T : undefined;
}

export function supportsHostedSandboxFlags(version: string): boolean {
  const match = REGEXP_EXEC(/^(\d+)\.(\d+)\.(\d+)(?:-|$)/, version);
  if (match === null) return false;
  const major = NUMBER(match[1]);
  const minor = NUMBER(match[2]);
  return major >= 24 || (major === 23 && minor >= 5) || (major === 22 && minor >= 13);
}

function unsupported(message: string): never {
  throw new PluginError('plugin_unsupported', message);
}
