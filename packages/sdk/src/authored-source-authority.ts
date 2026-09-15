import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonicalize } from './canonical.js';
import { loadAuthoredFlow } from './authored-flow-loader.js';
import type { AuthoredRootMetadata } from './authored-root.js';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Re-open the exact source graph and Surface instance pinned by the durable root. */
export async function loadPinnedAuthoredSource(metadata: AuthoredRootMetadata) {
  const source = await readFile(metadata.flowPath);
  if (sha256(source) !== metadata.sourceSha256) {
    throw new Error('authored root source authority mismatch');
  }
  for (const pinned of metadata.sources) {
    if (sha256(await readFile(pinned.path)) !== pinned.sourceSha256) {
      throw new Error(`authored root source authority mismatch for "${pinned.path}"`);
    }
  }
  const loaded = await loadAuthoredFlow(metadata.flowPath);
  if (canonicalize(loaded.surfaceAuthority) !== canonicalize(metadata.surface)
    || loaded.getDefinition(loaded.handle).name !== metadata.flowName) {
    throw new Error('authored root Surface module authority mismatch');
  }
  const loadedSources = loaded.graph.map(node => ({
    path: node.path,
    sourceSha256: metadata.sources.find(source => source.path === node.path)?.sourceSha256 ?? '',
    surface: node.surfaceAuthority,
  }));
  if (canonicalize(loadedSources) !== canonicalize(metadata.sources)) {
    throw new Error('authored root declared source graph authority mismatch');
  }
  return loaded;
}
