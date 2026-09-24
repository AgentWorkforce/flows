import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { canonicalize } from './canonical.js';
import {
  createHostedBaseSnapshot,
  hostedBaseSourceDigest,
  removeHostedBaseSnapshot,
  type HostedBaseSourceRoot,
} from './hosted-base-snapshot.js';
import { appendIntrinsicArray } from './intrinsic-array.js';
import {
  declarationSignature,
  hostedDeclaredExtensions,
} from './hosted-extension-declarations.js';
import { findHostedProject } from './hosted-project.js';
import {
  assertHostedPromiseSafety,
  frozenHostedPromiseValue,
} from './hosted-promise-safety.js';
import { PluginError } from './plugin-manifest.js';
import { pluginStoreDirectory, verifyStoredPlugin } from './plugin-store.js';

const INSTALLATION_AUTHORITY = new WeakSet<object>();
const BASE_AUTHORITY = new WeakSet<object>();
const REALPATH = realpath;
const PATH_DIRNAME = dirname;
const PATH_JOIN = join;
const PATH_RESOLVE = resolve;
const SOFTWARE_FACTORY_SHA256 = 'ee56899fcb5c0a968d845620db3d4229673a3b732dd4d6131ab43b81822bf97b';
const ARRAY_IS_ARRAY = Array.isArray;
const OBJECT_FREEZE = Object.freeze;
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
  assertHostedPromiseSafety('plugin_source_invalid');
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
  return frozenHostedPromiseValue({ installation: loaded.installation, base });
}

/** @internal Metadata-only test seam; public hosted callers use the combined loader. */
export async function loadHostedExtensionArtifacts(flowPath: string): Promise<HostedExtensionInstallation> {
  assertHostedPromiseSafety('plugin_source_invalid');
  const origin = await REALPATH(PATH_RESOLVE(flowPath));
  const generation = newGeneration(origin);
  const loaded = await installationAt(origin, generation);
  generation.declarations = loaded.declarations;
  return loaded.installation;
}

/** @internal Base-only test seam; public hosted callers use the combined loader. */
export async function loadHostedExtensionBase(flowPath: string): Promise<HostedExtensionBase> {
  assertHostedPromiseSafety('plugin_source_invalid');
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
    return frozenHostedPromiseValue({
      installation: installation([], generation),
      declarations: canonicalize([]),
    });
  const artifacts: HostedExtensionArtifact[] = [];
  const declared = hostedDeclaredExtensions(root);
  for (let index = 0; index < declared.length; index += 1) {
    const { ref, entry } = declared[index]!;
    const directory = pluginStoreDirectory(root, entry.name, entry.digest);
    await verifyStoredPlugin(directory, entry.digest);
    appendIntrinsicArray(artifacts, OBJECT_FREEZE({
      ref,
      name: entry.name,
      version: entry.version,
      directory,
      digest: entry.digest,
      manifestSha256: entry.manifestSha256,
    }));
  }
  return frozenHostedPromiseValue({
    installation: installation(artifacts, generation),
    declarations: declarationSignature(declared),
  });
}

function declaredExtensions(generation: RuntimeGeneration): { readonly signature: string } {
  const root = generation.projectRoot;
  return {
    signature: root === undefined ? canonicalize([]) : declarationSignature(hostedDeclaredExtensions(root)),
  };
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
    const value = frozenHostedPromiseValue({
      name: 'software-factory',
      version: '2.0.23',
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
  for (let index = 0; index < artifacts.length; index += 1) appendIntrinsicArray(artifactCopy, artifacts[index]!);
  const value = frozenHostedPromiseValue({ artifacts: frozenHostedPromiseValue(artifactCopy) });
  WEAK_SET_ADD(INSTALLATION_AUTHORITY, value);
  WEAK_MAP_SET(INSTALLATION_GENERATION, value, generation);
  return value;
}
