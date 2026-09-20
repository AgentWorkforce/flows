import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './bundle.js';
import { CloudFlowError } from './cloud-http.js';
import { extensionManifestOf } from './cli/add-extension.js';
import { assertCompatible, runtimeVersions } from './flow-extension-compat.js';
import type { LoadedAuthoredFlow } from './authored-flow-loader.js';
import type { FlowExtensionManifest } from './flow-extension-manifest.js';
import type { LoadedFlowExtension } from './flow-extension-loader.js';
import { fetchGithubPlugin, MAX_PLUGIN_TOTAL_BYTES, resolveGithubSha, type FetchLike } from './plugin-github.js';
import { PluginError } from './plugin-manifest.js';
import { canonicalPluginRef, parsePluginSource } from './plugin-source.js';
import { readStoredPluginFiles } from './plugin-store.js';

export const MAX_EXTENSIONS_BYTES = MAX_PLUGIN_TOTAL_BYTES;

export interface FlowExtensionFileSubmission {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly encoding: 'utf8' | 'base64';
  readonly content: string;
}

export interface FlowExtensionSubmission {
  readonly name: string;
  readonly version: string;
  readonly ref: string;
  readonly digest: string;
  readonly manifestSha256: string;
  readonly manifest: FlowExtensionManifest;
  readonly files: readonly FlowExtensionFileSubmission[];
}

function encodeFile(path: string, data: Uint8Array): FlowExtensionFileSubmission {
  const text = Buffer.from(data).toString('utf8');
  const utf8 = Buffer.from(text, 'utf8').equals(Buffer.from(data));
  return {
    path,
    sha256: sha256(data),
    bytes: data.length,
    encoding: utf8 ? 'utf8' : 'base64',
    content: utf8 ? text : Buffer.from(data).toString('base64'),
  };
}

function submissionSize(submission: FlowExtensionSubmission): number {
  return submission.files.reduce((sum, file) => sum + file.bytes, 0);
}

async function submissionFromStore(extension: LoadedFlowExtension): Promise<FlowExtensionSubmission> {
  const stored = await readStoredPluginFiles(extension.directory, extension.digest);
  const files = stored.filter(file => file.path !== 'manifest.json').map(file => encodeFile(file.path, file.data));
  const manifestBytes = readFileSync(join(extension.directory, 'flows-plugin.json'));
  return {
    name: extension.name, version: extension.version, ref: extension.ref, digest: extension.digest,
    manifestSha256: sha256(manifestBytes),
    manifest: extension.manifest,
    files,
  };
}

/** Resolve a GitHub plugin reference without writing the working tree. */
export async function resolveExtensionSubmission(
  input: string,
  options: { fetch?: FetchLike; versions?: { sdk: string; surface: string } } = {},
): Promise<FlowExtensionSubmission> {
  try {
    const source = await resolveGithubSha(parsePluginSource(input), options.fetch);
    const fetched = await fetchGithubPlugin(source, options.fetch);
    const { manifest, manifestSha256 } = extensionManifestOf(fetched);
    assertCompatible(manifest, options.versions ?? runtimeVersions());
    const files = fetched.files.map(file => encodeFile(file.path, file.data));
    return {
      name: manifest.name, version: manifest.version, ref: canonicalPluginRef(source),
      digest: fetched.digest, manifestSha256, manifest, files,
    };
  } catch (error) {
    if (error instanceof CloudFlowError) throw error;
    if (error instanceof PluginError) throw new CloudFlowError('invalid_input', error.message);
    throw new CloudFlowError('invalid_input', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Installed extensions plus optional send-only `--plugin` refs. Caps the
 * extensions field at 2 MB separately from the 256 KB source cap.
 */
export async function collectExtensionSubmissions(
  loaded: LoadedAuthoredFlow,
  extraRefs: readonly string[] = [],
  options: { fetch?: FetchLike } = {},
): Promise<readonly FlowExtensionSubmission[]> {
  const submissions: FlowExtensionSubmission[] = [];
  for (const extension of loaded.extensions) submissions.push(await submissionFromStore(extension));
  const names = new Set(submissions.map(s => s.name));
  for (const ref of extraRefs) {
    const extra = await resolveExtensionSubmission(ref, options);
    if (names.has(extra.name)) {
      throw new CloudFlowError('invalid_input', `Plugin ${extra.name} is already in this project; omit --plugin or remove the installed copy.`);
    }
    names.add(extra.name);
    submissions.push(extra);
  }
  const total = submissions.reduce((sum, item) => sum + submissionSize(item), 0);
  if (total > MAX_EXTENSIONS_BYTES) {
    throw new CloudFlowError('invalid_input', `Flow extensions exceed Cloud's ${MAX_EXTENSIONS_BYTES}-byte extensions cap.`);
  }
  return submissions;
}

/** Graph nodes besides the root must be the composed extensions, not `use:` children. */
export function assertNoUseDependencies(loaded: LoadedAuthoredFlow): void {
  if (loaded.graph.length !== 1 + loaded.extensions.length) {
    throw new CloudFlowError('unsupported_source',
      'Cloud deploys one self-contained .flow.ts source without use dependencies.');
  }
}
