import { constants, closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { safePath } from './bundle.js';
import { canonicalize } from './canonical.js';
import { descriptorIsFile } from './fs-descriptor.js';
import {
  createHostedBaseSnapshot,
  hostedBaseSourceDigest,
  removeHostedBaseSnapshot,
  type HostedBaseSourceRoot,
} from './hosted-base-snapshot.js';
import { findHostedProject } from './hosted-project.js';
import { snapshotJsonValue } from './json-value.js';
import { PluginError } from './plugin-manifest.js';
import { PLUGIN_LOCK_FILE, PLUGIN_LOCK_VERSION, type PluginLockEntry } from './plugin-lock.js';
import { canonicalPluginRef, type PluginSourceRef } from './plugin-source.js';
import { pluginStoreDirectory, verifyStoredPlugin } from './plugin-store.js';

const INSTALLATION_AUTHORITY = new WeakSet<object>();
const BASE_AUTHORITY = new WeakSet<object>();
const CLOSE_SYNC = closeSync;
const EXISTS_SYNC = existsSync;
const FSTAT_SYNC = fstatSync;
const OPEN_SYNC = openSync;
const READ_SYNC = readSync;
const REALPATH = realpath;
const PATH_DIRNAME = dirname;
const PATH_JOIN = join;
const PATH_RESOLVE = resolve;
const ERROR = Error;
const SOFTWARE_FACTORY_SHA256 = '49c993220b9c34fab2d4b0e51911656f62b8b657f534d988691960d45bb9d9b6';
const MAX_DECLARATION_BYTES = 1024 * 1024;
const BIG_INT = BigInt;
const BUFFER_ALLOC_UNSAFE = Buffer.allocUnsafe;
const BUFFER_TO_STRING = Function.prototype.call.bind(Buffer.prototype.toString) as (
  value: Buffer,
  encoding: BufferEncoding,
) => string;
const NUMBER = Number;
const DECLARATION_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const JSON_PARSE = JSON.parse;
const ARRAY_IS_ARRAY = Array.isArray;
const DATE_PARSE = Date.parse;
const NUMBER_IS_NAN = Number.isNaN;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_KEYS = Object.keys;
const REGEXP_TEST = Function.prototype.call.bind(RegExp.prototype.test) as (
  regexp: RegExp,
  value: string,
) => boolean;
const SET = Set;
const SET_ADD = Function.prototype.call.bind(Set.prototype.add) as <T>(set: Set<T>, value: T) => Set<T>;
const SET_HAS = Function.prototype.call.bind(Set.prototype.has) as <T>(set: Set<T>, value: T) => boolean;
const STRING_STARTS_WITH = Function.prototype.call.bind(String.prototype.startsWith) as (
  value: string,
  search: string,
) => boolean;
const WEAK_MAP_GET = Function.prototype.call.bind(WeakMap.prototype.get) as <K extends object, V>(
  map: WeakMap<K, V>,
  key: K,
) => V | undefined;
const WEAK_MAP_SET = Function.prototype.call.bind(WeakMap.prototype.set) as <K extends object, V>(
  map: WeakMap<K, V>,
  key: K,
  value: V,
) => WeakMap<K, V>;
const WEAK_SET_ADD = Function.prototype.call.bind(WeakSet.prototype.add) as <T extends object>(
  set: WeakSet<T>,
  value: T,
) => WeakSet<T>;
const WEAK_SET_HAS = Function.prototype.call.bind(WeakSet.prototype.has) as <T extends object>(
  set: WeakSet<T>,
  value: T,
) => boolean;
const LOCK_HEX64 = /^[0-9a-f]{64}$/;
const LOCK_SHA = /^[0-9a-f]{40}$/;
const LOCK_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const LOCK_REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const HTTPS_GITHUB = /^https:\/\/github\.com\//;

interface RuntimeGeneration {
  readonly origin: string;
  readonly projectRoot: string | undefined;
  declarations: string;
  sourceRoots: readonly HostedBaseSourceRoot[];
  sourceSha256: string;
}

const INSTALLATION_GENERATION = new WeakMap<object, RuntimeGeneration>();
const BASE_GENERATION = new WeakMap<object, RuntimeGeneration>();

export interface HostedExtensionArtifact {
  readonly ref: string;
  readonly name: string;
  readonly version: string;
  readonly directory: string;
  readonly digest: string;
  readonly manifestSha256: string;
}

export interface HostedExtensionInstallation {
  readonly artifacts: readonly HostedExtensionArtifact[];
}

export interface HostedExtensionBase {
  readonly name: string;
  readonly version?: string;
}

export interface HostedExtensionRuntime {
  readonly installation: HostedExtensionInstallation;
  readonly base: HostedExtensionBase;
}

/** Load one base/installation generation that cannot be paired across redeploys. */
export async function loadHostedExtensionRuntime(flowPath: string): Promise<HostedExtensionRuntime> {
  const origin = await REALPATH(PATH_RESOLVE(flowPath));
  const generation = newGeneration(origin);
  const loaded = await installationAt(origin, generation);
  generation.declarations = loaded.declarations;
  const base = await baseAt(origin, generation);
  if (loaded.declarations !== declaredExtensions(generation).signature) {
    throw new PluginError(
      'plugin_source_drift',
      'Hosted extension declarations changed while their runtime generation was loaded.',
    );
  }
  await assertCurrentGeneration(generation);
  OBJECT_FREEZE(generation);
  return OBJECT_FREEZE({ installation: loaded.installation, base });
}

/** @internal Metadata-only test seam; public hosted callers use the combined loader. */
export async function loadHostedExtensionArtifacts(flowPath: string): Promise<HostedExtensionInstallation> {
  const origin = await REALPATH(PATH_RESOLVE(flowPath));
  const generation = newGeneration(origin);
  const loaded = await installationAt(origin, generation);
  generation.declarations = loaded.declarations;
  return loaded.installation;
}

/** @internal Base-only test seam; public hosted callers use the combined loader. */
export async function loadHostedExtensionBase(flowPath: string): Promise<HostedExtensionBase> {
  const origin = await REALPATH(PATH_RESOLVE(flowPath));
  const generation = newGeneration(origin);
  generation.declarations = declaredExtensions(generation).signature;
  return await baseAt(origin, generation);
}

/** Validate both opaque values and refuse a cached generation after redeploy. */
export async function assertHostedRuntimeAuthority(
  installation: HostedExtensionInstallation,
  base: HostedExtensionBase,
): Promise<void> {
  if (typeof base !== 'object' || base === null || !WEAK_SET_HAS(BASE_AUTHORITY, base)) {
    throw new PluginError(
      'plugin_incompatible',
      'Hosted extension base authority is malformed; use loadHostedExtensionRuntime.',
    );
  }
  if (
    typeof installation !== 'object' ||
    installation === null ||
    !WEAK_SET_HAS(INSTALLATION_AUTHORITY, installation)
  ) {
    throw new PluginError(
      'plugin_source_invalid',
      'Hosted extension installation authority is malformed; use loadHostedExtensionRuntime.',
    );
  }
  const generation = WEAK_MAP_GET(BASE_GENERATION, base);
  if (generation === undefined || generation !== WEAK_MAP_GET(INSTALLATION_GENERATION, installation)) {
    throw new PluginError(
      'plugin_source_invalid',
      'Hosted extension base and installation must originate from the same runtime generation.',
    );
  }
  await assertCurrentGeneration(generation);
}

/** @internal Validate a metadata-only installation used by selection tests. */
export function assertHostedInstallationAuthority(value: unknown): asserts value is HostedExtensionInstallation {
  if (
    typeof value !== 'object' ||
    value === null ||
    !WEAK_SET_HAS(INSTALLATION_AUTHORITY, value) ||
    !ARRAY_IS_ARRAY((value as Partial<HostedExtensionInstallation>).artifacts)
  ) {
    throw new PluginError('plugin_source_invalid', 'Hosted extension installation authority is malformed.');
  }
}

async function installationAt(
  origin: string,
  generation: RuntimeGeneration,
): Promise<{
  installation: HostedExtensionInstallation;
  declarations: string;
}> {
  const root = generation.projectRoot;
  if (root === undefined)
    return {
      installation: installation([], generation),
      declarations: canonicalize([]),
    };
  const artifacts: HostedExtensionArtifact[] = [];
  const declared = hostedDeclaredExtensions(root);
  for (let index = 0; index < declared.length; index += 1) {
    const { ref, entry } = declared[index]!;
    const directory = pluginStoreDirectory(root, entry.name, entry.digest);
    await verifyStoredPlugin(directory, entry.digest);
    artifacts[artifacts.length] = OBJECT_FREEZE({
      ref,
      name: entry.name,
      version: entry.version,
      directory,
      digest: entry.digest,
      manifestSha256: entry.manifestSha256,
    });
  }
  return {
    installation: installation(artifacts, generation),
    declarations: declarationSignature(declared),
  };
}

function declaredExtensions(generation: RuntimeGeneration): { readonly signature: string } {
  const root = generation.projectRoot;
  return {
    signature: root === undefined ? canonicalize([]) : declarationSignature(hostedDeclaredExtensions(root)),
  };
}

function declarationSignature(declared: ReturnType<typeof hostedDeclaredExtensions>): string {
  const records: Array<{
    ref: string;
    name: string;
    version: string;
    digest: string;
    manifestSha256: string;
  }> = [];
  for (let index = 0; index < declared.length; index += 1) {
    const { ref, entry } = declared[index]!;
    records[index] = {
      ref,
      name: entry.name,
      version: entry.version,
      digest: entry.digest,
      manifestSha256: entry.manifestSha256,
    };
  }
  return canonicalize(records);
}

function hostedDeclaredExtensions(
  root: string,
): readonly { ref: string; entry: PluginLockEntry; source: PluginSourceRef }[] {
  if (EXISTS_SYNC(PATH_JOIN(root, 'flows.json.tmp')) || EXISTS_SYNC(PATH_JOIN(root, `${PLUGIN_LOCK_FILE}.tmp`))) {
    throw new PluginError('plugin_lock_invalid', 'Hosted extension declarations have a pending transaction.');
  }
  let config: unknown;
  try {
    config = JSON_PARSE(BUFFER_TO_STRING(readBoundedDeclaration(PATH_JOIN(root, 'flows.json')), 'utf8'));
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw new PluginError('plugin_manifest_invalid', 'Invalid or oversized flows.json.');
  }
  if (typeof config !== 'object' || config === null || ARRAY_IS_ARRAY(config)) {
    throw new PluginError('plugin_manifest_invalid', 'flows.json plugins must be strings.');
  }
  const plugins = OBJECT_HAS_OWN(config, 'plugins')
    ? (config as { plugins?: unknown }).plugins
    : undefined;
  if (plugins !== undefined && !ARRAY_IS_ARRAY(plugins)) {
    throw new PluginError('plugin_manifest_invalid', 'flows.json plugins must be strings.');
  }
  const declared: string[] = [];
  if (plugins !== undefined) {
    for (let index = 0; index < plugins.length; index += 1) {
      const ref = plugins[index];
      if (typeof ref !== 'string') {
        throw new PluginError('plugin_manifest_invalid', 'flows.json plugins must be strings.');
      }
      if (isHostedGithubPluginRef(ref)) declared[declared.length] = ref;
    }
  }
  let lock: { readonly version: 2; readonly plugins: readonly PluginLockEntry[] } = OBJECT_FREEZE({
    version: PLUGIN_LOCK_VERSION,
    plugins: OBJECT_FREEZE([]),
  });
  const lockPath = PATH_JOIN(root, PLUGIN_LOCK_FILE);
  if (EXISTS_SYNC(lockPath)) {
    let value: unknown;
    try {
      value = JSON_PARSE(BUFFER_TO_STRING(readBoundedDeclaration(lockPath), 'utf8'));
    } catch (error) {
      if (error instanceof PluginError) throw error;
      throw new PluginError('plugin_lock_invalid', `${PLUGIN_LOCK_FILE}: not valid or exceeds the hosted size limit.`);
    }
    lock = parseHostedPluginLock(value);
  }
  if (declared.length !== lock.plugins.length) {
    throw new PluginError('plugin_lock_invalid', 'Hosted flows.json and flows.lock.json declarations differ.');
  }
  const result: Array<{
    ref: string;
    entry: PluginLockEntry;
    source: PluginSourceRef;
  }> = [];
  for (let index = 0; index < lock.plugins.length; index += 1) {
    const entry = lock.plugins[index]!;
    const source = OBJECT_FREEZE({ ...entry.source, ref: entry.source.sha });
    const ref = canonicalPluginRef(source);
    if (declared[index] !== ref) {
      throw new PluginError('plugin_lock_invalid', 'Hosted flows.lock.json order differs from flows.json.plugins.');
    }
    result[result.length] = OBJECT_FREEZE({ ref, entry, source });
  }
  return OBJECT_FREEZE(result);
}

function parseHostedPluginLock(input: unknown): {
  readonly version: 2;
  readonly plugins: readonly PluginLockEntry[];
} {
  let value: unknown;
  try {
    value = snapshotJsonValue(input, 'hosted plugin lock');
  } catch {
    return invalidHostedLock(`expected { version: ${PLUGIN_LOCK_VERSION}, plugins: [] }.`);
  }
  if (!hostedRecord(value) || value.version !== PLUGIN_LOCK_VERSION || !ARRAY_IS_ARRAY(value.plugins)
    || !hostedHasOnlyKeys(value, ['version', 'plugins'])) {
    return invalidHostedLock(`expected { version: ${PLUGIN_LOCK_VERSION}, plugins: [] }.`);
  }
  const names = new SET<string>();
  const plugins: PluginLockEntry[] = [];
  for (let index = 0; index < value.plugins.length; index += 1) {
    const entry = value.plugins[index];
    if (!hostedRecord(entry)
      || !hostedHasOnlyKeys(entry, ['digest', 'kind', 'manifestSha256', 'name', 'order', 'resolvedAt', 'source', 'version'])
      || entry.kind !== 'flow-extension' || typeof entry.name !== 'string' || typeof entry.version !== 'string'
      || typeof entry.digest !== 'string' || !REGEXP_TEST(LOCK_HEX64, entry.digest)
      || typeof entry.manifestSha256 !== 'string' || !REGEXP_TEST(LOCK_HEX64, entry.manifestSha256)
      || entry.order !== index + 1 || typeof entry.resolvedAt !== 'string'
      || NUMBER_IS_NAN(DATE_PARSE(entry.resolvedAt)) || !hostedRecord(entry.source)
      || !hostedHasOnlyKeys(entry.source, ['host', 'owner', 'repo', 'sha', 'path'])
      || entry.source.host !== 'github' || typeof entry.source.owner !== 'string'
      || !REGEXP_TEST(LOCK_OWNER, entry.source.owner) || typeof entry.source.repo !== 'string'
      || !REGEXP_TEST(LOCK_REPO, entry.source.repo) || entry.source.repo === '.' || entry.source.repo === '..'
      || typeof entry.source.sha !== 'string' || !REGEXP_TEST(LOCK_SHA, entry.source.sha)
      || typeof entry.source.path !== 'string'
      || (entry.source.path !== '' && !safePath(entry.source.path))) {
      return invalidHostedLock(`plugins[${index}] is malformed.`);
    }
    if (SET_HAS(names, entry.name)) return invalidHostedLock(`plugin ${entry.name} is listed twice.`);
    SET_ADD(names, entry.name);
    plugins[plugins.length] = OBJECT_FREEZE({
      name: entry.name,
      kind: 'flow-extension',
      version: entry.version,
      source: OBJECT_FREEZE({
        host: 'github',
        owner: entry.source.owner,
        repo: entry.source.repo,
        sha: entry.source.sha,
        path: entry.source.path,
      }),
      digest: entry.digest,
      manifestSha256: entry.manifestSha256,
      order: entry.order,
      resolvedAt: entry.resolvedAt,
    });
  }
  return OBJECT_FREEZE({ version: PLUGIN_LOCK_VERSION, plugins: OBJECT_FREEZE(plugins) });
}

function isHostedGithubPluginRef(value: string): boolean {
  return STRING_STARTS_WITH(value, 'github:') || REGEXP_TEST(HTTPS_GITHUB, value);
}

function hostedRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !ARRAY_IS_ARRAY(value);
}

function hostedHasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = OBJECT_KEYS(value);
  for (let index = 0; index < keys.length; index += 1) {
    let found = false;
    for (let allowedIndex = 0; allowedIndex < allowed.length; allowedIndex += 1) {
      if (keys[index] === allowed[allowedIndex]) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function invalidHostedLock(message: string): never {
  throw new PluginError('plugin_lock_invalid', `${PLUGIN_LOCK_FILE}: ${message}`);
}

function readBoundedDeclaration(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = OPEN_SYNC(path, DECLARATION_READ_FLAGS);
    const before = FSTAT_SYNC(descriptor, { bigint: true });
    if (!descriptorIsFile(before) || before.size < 0n || before.size > BIG_INT(MAX_DECLARATION_BYTES)) {
      throw new PluginError('plugin_source_invalid', 'Hosted extension declaration is not a bounded regular file.');
    }
    const expected = NUMBER(before.size);
    const bytes = BUFFER_ALLOC_UNSAFE(expected);
    let offset = 0;
    while (offset < expected) {
      const count = READ_SYNC(descriptor, bytes, offset, expected - offset, offset);
      if (count === 0) throw new ERROR('short read');
      offset += count;
    }
    if (READ_SYNC(descriptor, BUFFER_ALLOC_UNSAFE(1), 0, 1, expected) !== 0) {
      throw new ERROR('grew');
    }
    const after = FSTAT_SYNC(descriptor, { bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new ERROR('changed');
    }
    return bytes;
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw new PluginError(
      'plugin_source_invalid',
      'Hosted extension declaration is unreadable or changed while reading.',
    );
  } finally {
    if (descriptor !== undefined) CLOSE_SYNC(descriptor);
  }
}

function newGeneration(origin: string): RuntimeGeneration {
  return {
    origin,
    projectRoot: findHostedProject(PATH_DIRNAME(origin)),
    declarations: canonicalize([]),
    sourceRoots: OBJECT_FREEZE([]),
    sourceSha256: '',
  };
}

async function assertCurrentGeneration(generation: RuntimeGeneration): Promise<void> {
  let currentSource: string;
  try {
    currentSource = await hostedBaseSourceDigest(generation.sourceRoots);
  } catch {
    throw new PluginError('plugin_source_invalid', 'Hosted extension runtime generation is no longer readable.');
  }
  if (
    declaredExtensions(generation).signature !== generation.declarations ||
    currentSource !== generation.sourceSha256
  ) {
    throw new PluginError(
      'plugin_source_invalid',
      'Hosted extension runtime generation is stale; reload the base and installation together.',
    );
  }
}

async function baseAt(origin: string, generation: RuntimeGeneration): Promise<HostedExtensionBase> {
  const snapshot = await createHostedBaseSnapshot(origin, generation.projectRoot ?? PATH_DIRNAME(origin));
  generation.sourceRoots = snapshot.liveSources;
  generation.sourceSha256 = snapshot.liveDigest;
  try {
    if (snapshot.snapshotFlowSha256 !== SOFTWARE_FACTORY_SHA256) {
      throw new PluginError(
        'plugin_source_invalid',
        'Hosted capability isolation accepts only the reviewed Software Factory base source.',
      );
    }
    const value = OBJECT_FREEZE({
      name: 'software-factory',
      version: '2.0.22',
    });
    WEAK_SET_ADD(BASE_AUTHORITY, value);
    WEAK_MAP_SET(BASE_GENERATION, value, generation);
    return value;
  } finally {
    await removeHostedBaseSnapshot(snapshot);
  }
}

function installation(
  artifacts: readonly HostedExtensionArtifact[],
  generation: RuntimeGeneration,
): HostedExtensionInstallation {
  const artifactCopy: HostedExtensionArtifact[] = [];
  for (let index = 0; index < artifacts.length; index += 1) artifactCopy[index] = artifacts[index]!;
  const value = OBJECT_FREEZE({ artifacts: OBJECT_FREEZE(artifactCopy) });
  WEAK_SET_ADD(INSTALLATION_AUTHORITY, value);
  WEAK_MAP_SET(INSTALLATION_GENERATION, value, generation);
  return value;
}
