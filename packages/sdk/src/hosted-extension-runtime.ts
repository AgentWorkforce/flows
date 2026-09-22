import { constants, closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { canonicalize } from './canonical.js';
import { sha256 } from './bundle.js';
import {
  createHostedBaseSnapshot,
  hostedBaseSourceDigest,
  removeHostedBaseSnapshot,
  type HostedBaseSourceRoot,
} from './hosted-base-snapshot.js';
import { PluginError } from './plugin-manifest.js';
import { findPluginProject } from './plugin-loader.js';
import {
  PLUGIN_LOCK_FILE,
  PLUGIN_LOCK_VERSION,
  parsePluginLock,
  type PluginLockEntry,
} from './plugin-lock.js';
import { canonicalPluginRef, isGithubPluginRef, type PluginSourceRef } from './plugin-source.js';
import { pluginStoreDirectory, verifyStoredPlugin } from './plugin-store.js';

const INSTALLATION_AUTHORITY = new WeakSet<object>();
const BASE_AUTHORITY = new WeakSet<object>();
const SOFTWARE_FACTORY_SHA256 = '49c993220b9c34fab2d4b0e51911656f62b8b657f534d988691960d45bb9d9b6';
const MAX_DECLARATION_BYTES = 1024 * 1024;
const DECLARATION_READ_FLAGS = constants.O_RDONLY
  | (constants.O_NOFOLLOW ?? 0)
  | (constants.O_NONBLOCK ?? 0);
const JSON_PARSE = JSON.parse;
const ARRAY_IS_ARRAY = Array.isArray;
const OBJECT_FREEZE = Object.freeze;
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_SET = WeakMap.prototype.set;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_HAS = WeakSet.prototype.has;

interface RuntimeGeneration {
  readonly origin: string;
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
  const origin = await realpath(resolve(flowPath));
  const generation = newGeneration(origin);
  const loaded = await installationAt(origin, generation);
  generation.declarations = loaded.declarations;
  const base = await baseAt(origin, generation);
  if (loaded.declarations !== declaredExtensions(origin).signature) {
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
export async function loadHostedExtensionArtifacts(
  flowPath: string,
): Promise<HostedExtensionInstallation> {
  const origin = await realpath(resolve(flowPath));
  const generation = newGeneration(origin);
  const loaded = await installationAt(origin, generation);
  generation.declarations = loaded.declarations;
  return loaded.installation;
}

/** @internal Base-only test seam; public hosted callers use the combined loader. */
export async function loadHostedExtensionBase(flowPath: string): Promise<HostedExtensionBase> {
  const origin = await realpath(resolve(flowPath));
  const generation = newGeneration(origin);
  generation.declarations = declaredExtensions(origin).signature;
  return await baseAt(origin, generation);
}

/** Validate both opaque values and refuse a cached generation after redeploy. */
export async function assertHostedRuntimeAuthority(
  installation: HostedExtensionInstallation,
  base: HostedExtensionBase,
): Promise<void> {
  if (typeof base !== 'object' || base === null || !WEAK_SET_HAS.call(BASE_AUTHORITY, base)) {
    throw new PluginError(
      'plugin_incompatible',
      'Hosted extension base authority is malformed; use loadHostedExtensionRuntime.',
    );
  }
  if (typeof installation !== 'object' || installation === null
    || !WEAK_SET_HAS.call(INSTALLATION_AUTHORITY, installation)) {
    throw new PluginError(
      'plugin_source_invalid',
      'Hosted extension installation authority is malformed; use loadHostedExtensionRuntime.',
    );
  }
  const generation = WEAK_MAP_GET.call(BASE_GENERATION, base);
  if (generation === undefined || generation !== WEAK_MAP_GET.call(INSTALLATION_GENERATION, installation)) {
    throw new PluginError(
      'plugin_source_invalid',
      'Hosted extension base and installation must originate from the same runtime generation.',
    );
  }
  await assertCurrentGeneration(generation);
}

/** @internal Validate a metadata-only installation used by selection tests. */
export function assertHostedInstallationAuthority(value: unknown): asserts value is HostedExtensionInstallation {
  if (typeof value !== 'object' || value === null || !WEAK_SET_HAS.call(INSTALLATION_AUTHORITY, value)
    || !ARRAY_IS_ARRAY((value as Partial<HostedExtensionInstallation>).artifacts)) {
    throw new PluginError('plugin_source_invalid', 'Hosted extension installation authority is malformed.');
  }
}

async function installationAt(
  origin: string,
  generation: RuntimeGeneration,
): Promise<{ installation: HostedExtensionInstallation; declarations: string }> {
  const root = findPluginProject(dirname(origin));
  if (root === undefined) return {
    installation: installation([], generation), declarations: canonicalize([]),
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

function declaredExtensions(origin: string): { readonly signature: string } {
  const root = findPluginProject(dirname(origin));
  return {
    signature: root === undefined
      ? canonicalize([])
      : declarationSignature(hostedDeclaredExtensions(root)),
  };
}

function declarationSignature(
  declared: ReturnType<typeof hostedDeclaredExtensions>,
): string {
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
  if (existsSync(join(root, 'flows.json.tmp')) || existsSync(join(root, `${PLUGIN_LOCK_FILE}.tmp`))) {
    throw new PluginError('plugin_lock_invalid', 'Hosted extension declarations have a pending transaction.');
  }
  let config: unknown;
  try { config = JSON_PARSE(readBoundedDeclaration(join(root, 'flows.json')).toString('utf8')); }
  catch (error) {
    if (error instanceof PluginError) throw error;
    throw new PluginError('plugin_manifest_invalid', 'Invalid or oversized flows.json.');
  }
  if (typeof config !== 'object' || config === null || ARRAY_IS_ARRAY(config)) {
    throw new PluginError('plugin_manifest_invalid', 'flows.json plugins must be strings.');
  }
  const plugins = (config as { plugins?: unknown }).plugins;
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
      if (isGithubPluginRef(ref)) declared[declared.length] = ref;
    }
  }
  let lock: ReturnType<typeof parsePluginLock> = OBJECT_FREEZE({
    version: PLUGIN_LOCK_VERSION,
    plugins: OBJECT_FREEZE([]),
  });
  const lockPath = join(root, PLUGIN_LOCK_FILE);
  if (existsSync(lockPath)) {
    let value: unknown;
    try { value = JSON_PARSE(readBoundedDeclaration(lockPath).toString('utf8')); }
    catch (error) {
      if (error instanceof PluginError) throw error;
      throw new PluginError('plugin_lock_invalid', `${PLUGIN_LOCK_FILE}: not valid or exceeds the hosted size limit.`);
    }
    lock = parsePluginLock(value);
  }
  if (declared.length !== lock.plugins.length) {
    throw new PluginError('plugin_lock_invalid', 'Hosted flows.json and flows.lock.json declarations differ.');
  }
  const result: Array<{ ref: string; entry: PluginLockEntry; source: PluginSourceRef }> = [];
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

function readBoundedDeclaration(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, DECLARATION_READ_FLAGS);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size < 0n || before.size > BigInt(MAX_DECLARATION_BYTES)) {
      throw new PluginError('plugin_source_invalid', 'Hosted extension declaration is not a bounded regular file.');
    }
    const expected = Number(before.size);
    const bytes = Buffer.allocUnsafe(expected);
    let offset = 0;
    while (offset < expected) {
      const count = readSync(descriptor, bytes, offset, expected - offset, offset);
      if (count === 0) throw new Error('short read');
      offset += count;
    }
    if (readSync(descriptor, Buffer.allocUnsafe(1), 0, 1, expected) !== 0) throw new Error('grew');
    const after = fstatSync(descriptor, { bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new Error('changed');
    }
    return bytes;
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw new PluginError('plugin_source_invalid', 'Hosted extension declaration is unreadable or changed while reading.');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function newGeneration(origin: string): RuntimeGeneration {
  return {
    origin,
    declarations: canonicalize([]),
    sourceRoots: OBJECT_FREEZE([]),
    sourceSha256: '',
  };
}

async function assertCurrentGeneration(generation: RuntimeGeneration): Promise<void> {
  let currentSource: string;
  try { currentSource = await hostedBaseSourceDigest(generation.sourceRoots); }
  catch {
    throw new PluginError('plugin_source_invalid', 'Hosted extension runtime generation is no longer readable.');
  }
  if (declaredExtensions(generation.origin).signature !== generation.declarations
    || currentSource !== generation.sourceSha256) {
    throw new PluginError(
      'plugin_source_invalid',
      'Hosted extension runtime generation is stale; reload the base and installation together.',
    );
  }
}

async function baseAt(
  origin: string,
  generation: RuntimeGeneration,
): Promise<HostedExtensionBase> {
  const snapshot = await createHostedBaseSnapshot(origin);
  generation.sourceRoots = snapshot.liveSources;
  generation.sourceSha256 = snapshot.liveDigest;
  try {
    const baseBytes = await readFile(snapshot.snapshotFlowPath);
    if (sha256(baseBytes) !== SOFTWARE_FACTORY_SHA256) {
      throw new PluginError(
        'plugin_source_invalid',
        'Hosted capability isolation accepts only the reviewed Software Factory base source.',
      );
    }
    const value = OBJECT_FREEZE({ name: 'software-factory', version: '2.0.22' });
    WEAK_SET_ADD.call(BASE_AUTHORITY, value);
    WEAK_MAP_SET.call(BASE_GENERATION, value, generation);
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
  WEAK_SET_ADD.call(INSTALLATION_AUTHORITY, value);
  WEAK_MAP_SET.call(INSTALLATION_GENERATION, value, generation);
  return value;
}
