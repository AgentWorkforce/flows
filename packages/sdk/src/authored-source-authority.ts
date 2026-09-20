import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { canonicalize } from './canonical.js';
import { loadAuthoredFlow } from './authored-flow-loader.js';
import type { AuthoredRootMetadata } from './authored-root.js';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Re-open the exact source graph and Surface instance pinned by the durable root. */
export async function loadPinnedAuthoredSource(metadata: AuthoredRootMetadata, immutableNodeImport = false) {
  const source = await readFile(metadata.flowPath);
  if (sha256(source) !== metadata.sourceSha256) {
    throw new Error('authored root source authority mismatch');
  }
  const sources = new Map([[pathToFileURL(metadata.flowPath).href, source.toString('utf8')]]);
  for (const pinned of metadata.sources) {
    const bytes = await readFile(pinned.path);
    if (sha256(bytes) !== pinned.sourceSha256) {
      throw new Error(`authored root source authority mismatch for "${pinned.path}"`);
    }
    sources.set(pathToFileURL(pinned.path).href, bytes.toString('utf8'));
  }
  if (immutableNodeImport) installPinnedSourceLoader(sources);
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

let pinnedSourceLoaderInstalled = false;

/** Isolated Node child only: preserve original URLs/resolution, load verified bytes. */
function installPinnedSourceLoader(sources: Map<string, string>): void {
  if (pinnedSourceLoaderInstalled) throw new Error('authored Node process already owns a source graph');
  pinnedSourceLoaderInstalled = true;
  // Node >=22.14 supports register and stripTypeScriptTypes. A loader thread
  // receives the captured bytes, never reopening mutable authored paths.
  // The `stripTypeScriptTypes` call below makes Node emit
  // `ExperimentalWarning: stripTypeScriptTypes …` on the child's inherited
  // stderr, where a bootstrap that reads the CLI's stderr takes it for the
  // error text. It is emitted on this loader thread, so a listener on the
  // main thread cannot intercept it, and `--disable-warning` on the child
  // would silence every ExperimentalWarning the authored body raises too.
  // Dropping it by its own text, on this thread only, is the narrow form:
  // Node's own printer still handles every other warning.
  const loader = `
    const emitWarning = process.emitWarning.bind(process);
    process.emitWarning = (warning, ...rest) => {
      if (rest[0] === 'ExperimentalWarning' && String(warning).startsWith('stripTypeScriptTypes')) return;
      emitWarning(warning, ...rest);
    };
    import {stripTypeScriptTypes} from 'node:module';
    let sources;
    export function initialize(data){sources=new Map(data);}
    export async function load(url,context,next){
      if(sources.has(url))return {format:'module',shortCircuit:true,
        source:stripTypeScriptTypes(sources.get(url),{mode:'transform',sourceUrl:url})};
      if(url.startsWith('file:') && new URL(url).pathname.endsWith('.flow.ts'))
        throw new Error('authored root declared source graph authority mismatch');
      return next(url,context);
    }
  `;
  register('data:text/javascript,' + encodeURIComponent(loader), { data: [...sources] });
}
