import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  hostedExtensionBaseFromLoadedFlow,
  loadAuthoredFlow,
} from './authored-flow-loader.js';
import { canonicalize } from './canonical.js';
import { PluginError } from './plugin-manifest.js';
import { findPluginProject } from './plugin-loader.js';
import { reconcileDeclaredExtensions } from './plugin-lock.js';
import { pluginStoreDirectory, verifyStoredPlugin } from './plugin-store.js';

const INSTALLATION_AUTHORITY = new WeakSet<object>();
const BASE_AUTHORITY = new WeakSet<object>();

interface RuntimeGeneration {
  readonly origin: string;
  declarations: string;
  graphPaths: readonly string[];
  graphSha256: string;
  readonly importNonce: string;
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
  Object.freeze(generation);
  return Object.freeze({ installation: loaded.installation, base });
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
  if (typeof base !== 'object' || base === null || !BASE_AUTHORITY.has(base)) {
    throw new PluginError(
      'plugin_incompatible',
      'Hosted extension base authority is malformed; use loadHostedExtensionRuntime.',
    );
  }
  if (typeof installation !== 'object' || installation === null
    || !INSTALLATION_AUTHORITY.has(installation)) {
    throw new PluginError(
      'plugin_source_invalid',
      'Hosted extension installation authority is malformed; use loadHostedExtensionRuntime.',
    );
  }
  const generation = BASE_GENERATION.get(base);
  if (generation === undefined || generation !== INSTALLATION_GENERATION.get(installation)) {
    throw new PluginError(
      'plugin_source_invalid',
      'Hosted extension base and installation must originate from the same runtime generation.',
    );
  }
  await assertCurrentGeneration(generation);
}

/** @internal Validate a metadata-only installation used by selection tests. */
export function assertHostedInstallationAuthority(value: unknown): asserts value is HostedExtensionInstallation {
  if (typeof value !== 'object' || value === null || !INSTALLATION_AUTHORITY.has(value)
    || !Array.isArray((value as Partial<HostedExtensionInstallation>).artifacts)) {
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
  const declared = reconcileDeclaredExtensions(root);
  for (const { ref, entry } of declared) {
    const directory = pluginStoreDirectory(root, entry.name, entry.digest);
    await verifyStoredPlugin(directory, entry.digest);
    artifacts.push(Object.freeze({
      ref,
      name: entry.name,
      version: entry.version,
      directory,
      digest: entry.digest,
      manifestSha256: entry.manifestSha256,
    }));
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
      : declarationSignature(reconcileDeclaredExtensions(root)),
  };
}

function declarationSignature(
  declared: ReturnType<typeof reconcileDeclaredExtensions>,
): string {
  return canonicalize(declared.map(({ ref, entry }) => ({
    ref,
    name: entry.name,
    version: entry.version,
    digest: entry.digest,
    manifestSha256: entry.manifestSha256,
  })));
}

function newGeneration(origin: string): RuntimeGeneration {
  return {
    origin,
    declarations: canonicalize([]),
    graphPaths: Object.freeze([]),
    graphSha256: '',
    importNonce: randomUUID(),
  };
}

async function graphSha256(paths: readonly string[]): Promise<string> {
  const files = await Promise.all(paths.map(async path => ({
    path,
    sha256: sha256(await readFile(path)),
  })));
  return sha256(canonicalize(files));
}

async function assertCurrentGeneration(generation: RuntimeGeneration): Promise<void> {
  let currentGraph: string;
  try { currentGraph = await graphSha256(generation.graphPaths); }
  catch {
    throw new PluginError('plugin_source_invalid', 'Hosted extension runtime generation is no longer readable.');
  }
  if (declaredExtensions(generation.origin).signature !== generation.declarations
    || currentGraph !== generation.graphSha256) {
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
  const loaded = await loadAuthoredFlow(origin, {
    extensions: 'none',
    importNonce: generation.importNonce,
  });
  generation.graphPaths = Object.freeze(loaded.graph.map(node => node.path));
  generation.graphSha256 = await graphSha256(generation.graphPaths);
  const identity = hostedExtensionBaseFromLoadedFlow(loaded);
  const value = Object.freeze({
    name: identity.name,
    ...(identity.version === undefined ? {} : { version: identity.version }),
  });
  BASE_AUTHORITY.add(value);
  BASE_GENERATION.set(value, generation);
  return value;
}

function installation(
  artifacts: readonly HostedExtensionArtifact[],
  generation: RuntimeGeneration,
): HostedExtensionInstallation {
  const value = Object.freeze({ artifacts: Object.freeze([...artifacts]) });
  INSTALLATION_AUTHORITY.add(value);
  INSTALLATION_GENERATION.set(value, generation);
  return value;
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}
