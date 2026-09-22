import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { canonicalize } from './canonical.js';
import { findPluginProject } from './plugin-loader.js';
import { PluginError } from './plugin-manifest.js';

const EXCLUDED_DIRECTORIES = new Set(['.flows', '.git', 'node_modules']);
const MAX_FILES = 10_000;
const MAX_BYTES = 64 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const hostRequire = createRequire(import.meta.url);

interface SourceFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface HostedBaseSourceRoot {
  readonly root: string;
  readonly prefix: string;
}

export interface HostedBaseSnapshot {
  readonly liveSources: readonly HostedBaseSourceRoot[];
  readonly liveDigest: string;
  readonly snapshotRoot: string;
  readonly snapshotFlowPath: string;
  readonly snapshotSurfaceDefinitionPath: string;
}

export interface HostedBaseIdentity {
  readonly name: string;
  readonly version?: string;
}

/**
 * Materialize project source plus the SDK-owned Surface package. Project
 * node_modules is never linked or read by the imported base; any package other
 * than the host's attested Surface fails resolution. Every executable file is
 * represented in liveDigest and copied to the private identity directory.
 */
export async function createHostedBaseSnapshot(
  flowPath: string,
  /** @internal Test seam; hosted callers cannot supply trust roots. */
  surfaceEntry = hostRequire.resolve('@relayflows/surface'),
): Promise<HostedBaseSnapshot> {
  const origin = await realpath(resolve(flowPath));
  const discovered = findPluginProject(dirname(origin)) ?? dirname(origin);
  const projectRoot = await realpath(discovered);
  const flowRelative = relative(projectRoot, origin);
  if (flowRelative === '' || isAbsolute(flowRelative)
    || flowRelative === '..' || flowRelative.startsWith(`..${sep}`)) {
    throw invalid('Hosted base flow must be a file inside its project root.');
  }
  const liveSources = await trustedSourceRoots(projectRoot, surfaceEntry);
  const files = await readAuthorityFiles(liveSources);
  const liveDigest = sourceDigest(files);
  const snapshotRoot = await mkdtemp(join(tmpdir(), 'flows-hosted-base-'));
  await chmod(snapshotRoot, 0o700);
  try {
    for (const file of files) {
      const target = join(snapshotRoot, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.bytes, { flag: 'wx', mode: 0o400 });
    }
    const snapshotFiles = await readSnapshotTree(snapshotRoot);
    const snapshotDigest = sourceDigest(snapshotFiles);
    if (snapshotDigest !== liveDigest) {
      throw invalid('Hosted base private snapshot does not match its buffered source.');
    }
    return Object.freeze({
      liveSources,
      liveDigest,
      snapshotRoot,
      snapshotFlowPath: join(snapshotRoot, flowRelative),
      snapshotSurfaceDefinitionPath: join(snapshotRoot, 'node_modules/@relayflows/surface/dist/flow.js'),
    });
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Import the private snapshot in a child that cannot read fallback packages. */
export async function hostedBaseIdentityFromSnapshot(
  snapshot: HostedBaseSnapshot,
): Promise<HostedBaseIdentity> {
  const bootstrap = `
    const [flowUrl, runtimeUrl] = JSON.parse(process.argv[1]);
    const authored = await import(flowUrl);
    const runtime = await import(runtimeUrl);
    const definition = runtime.getFlowDefinition(authored.default);
    const identity = {name: definition.name};
    if (definition.header.version !== undefined) identity.version = definition.header.version;
    process.stdout.write(JSON.stringify(identity));
  `;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [
      '--permission',
      `--allow-fs-read=${snapshot.snapshotRoot}`,
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      '--input-type=module',
      '--eval', bootstrap,
      JSON.stringify([
        pathToFileURL(snapshot.snapshotFlowPath).href,
        pathToFileURL(snapshot.snapshotSurfaceDefinitionPath).href,
      ]),
    ], { cwd: snapshot.snapshotRoot, env: {}, timeout: 10_000, maxBuffer: 4096 }));
  } catch {
    throw invalid('Hosted base could not be imported from its private dependency snapshot.');
  }
  let value: unknown;
  try { value = JSON.parse(stdout); }
  catch { throw invalid('Hosted base identity response is malformed.'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || typeof (value as { name?: unknown }).name !== 'string'
    || ((value as { version?: unknown }).version !== undefined
      && typeof (value as { version?: unknown }).version !== 'string')
    || Object.keys(value).some(key => !['name', 'version'].includes(key))) {
    throw invalid('Hosted base identity response is malformed.');
  }
  const identity = value as { name: string; version?: string };
  return Object.freeze({
    name: identity.name,
    ...(identity.version === undefined ? {} : { version: identity.version }),
  });
}

export async function hostedBaseSourceDigest(
  sources: readonly HostedBaseSourceRoot[],
): Promise<string> {
  return sourceDigest(await readAuthorityFiles(sources));
}

export async function removeHostedBaseSnapshot(snapshot: HostedBaseSnapshot): Promise<void> {
  await rm(snapshot.snapshotRoot, { recursive: true, force: true });
}

async function trustedSourceRoots(
  projectRoot: string,
  surfaceEntry: string,
): Promise<readonly HostedBaseSourceRoot[]> {
  const surfaceRoot = await packageRoot(surfaceEntry, '@relayflows/surface');
  return Object.freeze([
    Object.freeze({ root: projectRoot, prefix: '' }),
    Object.freeze({ root: surfaceRoot, prefix: join('node_modules', '@relayflows/surface') }),
  ]);
}

async function packageRoot(entry: string, expectedName: string): Promise<string> {
  let current = dirname(await realpath(entry));
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(join(current, 'package.json'), 'utf8')) as { name?: unknown };
      if (manifest.name === expectedName) return current;
    } catch { /* continue toward the filesystem root */ }
    const parent = dirname(current);
    if (parent === current) throw invalid(`Hosted base trusted dependency ${expectedName} has no package root.`);
    current = parent;
  }
}

async function readAuthorityFiles(sources: readonly HostedBaseSourceRoot[]): Promise<readonly SourceFile[]> {
  const files = (await Promise.all(sources.map(source => readTree(source.root, source.prefix)))).flat();
  files.sort((left, right) => left.path.localeCompare(right.path));
  const totalBytes = files.reduce((total, file) => total + file.bytes.byteLength, 0);
  if (files.length > MAX_FILES || totalBytes > MAX_BYTES) {
    throw invalid('Hosted base source and trusted dependencies exceed the snapshot limit.');
  }
  return Object.freeze(files);
}

async function readSnapshotTree(root: string): Promise<readonly SourceFile[]> {
  const files: SourceFile[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : join(prefix, entry.name);
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, path);
      else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        files.push(Object.freeze({ path, bytes, sha256: sha256(bytes) }));
      } else throw invalid(`Hosted base snapshot contains unsupported entry "${path}".`);
    }
  }
  await visit(root, '');
  files.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze(files);
}

async function readTree(root: string, prefix: string): Promise<readonly SourceFile[]> {
  const files: SourceFile[] = [];
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const relativePath = relativeDirectory === '' ? entry.name : join(relativeDirectory, entry.name);
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath, relativePath);
      else if (entry.isFile()) {
        const bytes = await readFile(absolutePath);
        files.push(Object.freeze({
          path: prefix === '' ? relativePath : join(prefix, relativePath),
          bytes,
          sha256: sha256(bytes),
        }));
      } else throw invalid(`Hosted base authority contains unsupported entry "${relativePath}".`);
    }
  }
  try { await visit(root, ''); }
  catch (error) {
    if (error instanceof PluginError) throw error;
    throw invalid('Hosted base source or trusted dependency is unreadable.');
  }
  return Object.freeze(files);
}

function sourceDigest(files: readonly SourceFile[]): string {
  return sha256(canonicalize(files.map(file => ({ path: file.path, sha256: file.sha256 }))));
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function invalid(message: string): PluginError {
  return new PluginError('plugin_source_invalid', message);
}
