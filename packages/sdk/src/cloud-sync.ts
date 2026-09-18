import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import {
  CloudFlowError, cloudFetch, cloudRequest, cloudRunId, isCloudRecord, type CloudConnectionOptions,
} from './cloud-http.js';

/**
 * Code sync for hosted v2 runs, Cloud-API transport only.
 *
 * v1's `--sync-code` had two transports: an S3 client with STS credentials and
 * the Cloud API's own storage route. v2 runs on Cloudflare, so this module
 * speaks only the second: `prepare` must answer with a `cloud-api` storage
 * backend, the tarball is `PUT` to `/workflows/runs/<id>/storage/<key>`, and
 * the sandbox's post-run patch is read from `/workflows/runs/<id>/patch`. A
 * `prepare` that hands back anything else is refused before any upload — the
 * SDK never carries an AWS dependency and never sends code to a bucket it did
 * not get through the Cloud API.
 */

/** Uncompressed bytes. Matches the sandbox's extraction budget with headroom. */
export const MAX_SYNC_BYTES = 256 * 1024 * 1024;
const ALWAYS_SKIPPED = new Set(['.git', 'node_modules']);
const CODE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface PreparedCloudSync {
  runId: string;
  codeKey: string;
  /** Run-scoped upload credential from `prepare`; falls back to the session token. */
  uploadToken?: string;
}

/** `POST /api/v1/workflows/prepare`, refusing every non-Cloud-API storage backend. */
export async function prepareCloudSync(options: CloudConnectionOptions): Promise<PreparedCloudSync> {
  const receipt = await cloudFetch('/api/v1/workflows/prepare', options, { method: 'POST' });
  if (!isCloudRecord(receipt)) throw new CloudFlowError('invalid_response', 'Cloud prepare returned a non-object.');
  const storage = isCloudRecord(receipt.workflowStorage) ? receipt.workflowStorage : undefined;
  const credentials = isCloudRecord(receipt.s3Credentials) ? receipt.s3Credentials : undefined;
  const backend = storage?.backend ?? credentials?.backend;
  if (backend !== 'cloud-api') {
    throw new CloudFlowError('unsupported_storage_backend',
      'Cloud offered a workflow storage backend other than the Cloud API (R2). '
      + 'flows v2 syncs code only through the Cloud API; it never uploads to AWS directly.');
  }
  const codeKey = typeof receipt.s3CodeKey === 'string' ? receipt.s3CodeKey : '';
  if (!CODE_KEY.test(codeKey)) throw new CloudFlowError('invalid_response', 'Cloud prepare returned an unusable code key.');
  const uploadToken = credentials?.cloudApiAccessToken;
  if (uploadToken !== undefined && typeof uploadToken !== 'string') {
    throw new CloudFlowError('invalid_response', 'Cloud prepare returned an unusable storage credential.');
  }
  return {
    runId: cloudRunId(receipt.runId), codeKey,
    ...(uploadToken === undefined ? {} : { uploadToken }),
  };
}

export interface PackedTree {
  /** The gzip'd ustar, spooled to a temporary file; `dispose()` removes it. */
  archivePath: string;
  /** Archive members, `root`-relative POSIX paths, sorted. */
  files: string[];
  /** Uncompressed byte total across regular files. */
  bytes: number;
  /** Symlinks left out because their target resolves outside `root`. */
  skippedLinks: string[];
  dispose(): void;
}

/**
 * gzip'd ustar of the working tree at `root`, streamed to a temporary file so
 * the peak footprint is one file plus the compressor's window, never the
 * whole tree. Inside a Git checkout the member list is `git ls-files --cached
 * --others --exclude-standard`, so `.gitignore` governs and untracked-but-
 * not-ignored files ride along, as they do in v1. Outside Git, every regular
 * file and in-tree symlink except `.git`/`node_modules`. A Git failure other
 * than "not a repository" is refused rather than silently widened to the walk:
 * an ignored `.env` must never reach Cloud because `git` was missing or the
 * index was locked. Executable bits survive; symlinks whose target leaves the
 * tree are dropped and reported, since on the host they would point at
 * whatever happens to live at that path. Ordering and mtimes are
 * deterministic, so the same tree packs to the same bytes.
 */
export async function packWorkingTree(root: string): Promise<PackedTree> {
  const absoluteRoot = resolve(root);
  const files = listTreeFiles(absoluteRoot);
  const spool = mkdtempSync(join(tmpdir(), 'flows-sync-'));
  const archivePath = join(spool, 'code.tar.gz');
  const dispose = (): void => rmSync(spool, { recursive: true, force: true });
  const members: string[] = [];
  const skippedLinks: string[] = [];
  let bytes = 0;
  async function* entries(): AsyncGenerator<Buffer | NodeJS.ReadableStream> {
    for (const path of files) {
      const absolute = join(absoluteRoot, ...path.split('/'));
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        const relativeTarget = relative(absoluteRoot, resolve(dirname(absolute), target));
        if (isAbsolute(target) || relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`)) {
          skippedLinks.push(path);
          continue;
        }
        members.push(path);
        yield ustarHeader(path, 0, '2', 0o777, target);
        continue;
      }
      if (!stat.isFile()) continue;
      bytes += stat.size;
      if (bytes > MAX_SYNC_BYTES) {
        throw new CloudFlowError('sync_too_large',
          `The working tree exceeds the ${MAX_SYNC_BYTES}-byte code sync limit; narrow it with .gitignore.`);
      }
      members.push(path);
      yield ustarHeader(path, stat.size, '0', stat.mode & 0o111 ? 0o755 : 0o644);
      yield createReadStream(absolute);
      const padding = (512 - (stat.size % 512)) % 512;
      if (padding) yield Buffer.alloc(padding);
    }
    yield Buffer.alloc(1024);
  }
  try {
    await pipeline(Readable.from(flatten(entries())), createGzip({ level: 6 }), createWriteStream(archivePath));
  } catch (error) {
    dispose();
    throw error;
  }
  return { archivePath, files: members, bytes, skippedLinks, dispose };
}

/** Yield file streams chunk by chunk so `Readable.from` never buffers a whole file. */
async function* flatten(source: AsyncGenerator<Buffer | NodeJS.ReadableStream>): AsyncGenerator<Buffer> {
  for await (const part of source) {
    if (Buffer.isBuffer(part)) { yield part; continue; }
    for await (const chunk of part as AsyncIterable<Buffer>) yield chunk;
  }
}

/** The nearest `.git` entry at `root` or any ancestor — the checkout a .gitignore would belong to. */
function nearestGitEntry(root: string): string | undefined {
  let directory = root;
  while (true) {
    if (existsSync(join(directory, '.git'))) return join(directory, '.git');
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function listTreeFiles(root: string): string[] {
  const inside = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  if (inside.error !== undefined) {
    // Without git there is no way to honour a .gitignore, so a tree that has
    // one anywhere above it cannot be described honestly; a tree with none is
    // a plain directory and can be walked.
    const entry = nearestGitEntry(root);
    if (entry !== undefined) {
      throw new CloudFlowError('sync_unsupported',
        `git is not available (${summarize(inside.error.message)}) but ${entry} exists; `
        + 'refusing to upload a checkout without its .gitignore.');
    }
  }
  const notARepository = inside.error !== undefined
    || (inside.status !== 0 && /not a git repository/iu.test(inside.stderr));
  let candidates: string[];
  if (notARepository) {
    // A `.git` that git itself cannot read — here or in a parent — is a broken
    // checkout, not a plain directory: its .gitignore was meant to apply, so
    // walking would upload exactly what it excluded.
    const entry = nearestGitEntry(root);
    if (entry !== undefined) {
      throw new CloudFlowError('sync_unsupported',
        `${entry} exists but git cannot read it (${summarize(inside.stderr ?? inside.error?.message)}); `
        + 'refusing to upload a checkout without its .gitignore.');
    }
    candidates = [];
    walk(root, root, candidates);
  } else {
    if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
      throw new CloudFlowError('sync_unsupported',
        `git could not describe ${root} (${summarize(inside.stderr)}); refusing to guess which files to upload.`);
    }
    const git = spawnSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (git.status !== 0) {
      throw new CloudFlowError('sync_unsupported',
        `git ls-files failed in ${root} (${summarize(git.stderr)}); refusing to upload without .gitignore.`);
    }
    candidates = git.stdout.split('\0').filter(Boolean);
  }
  const files = new Set<string>();
  for (const candidate of candidates) {
    const path = candidate.split(sep).join('/');
    const segments = path.split('/');
    if (segments.some(segment => ALWAYS_SKIPPED.has(segment) || segment === '..' || segment === '')) continue;
    let stat;
    try { stat = lstatSync(join(root, ...segments)); } catch { continue; }
    if (stat.isFile() || stat.isSymbolicLink()) files.add(path);
  }
  return [...files].sort();
}

function summarize(stderr: string | undefined): string {
  const line = (stderr ?? '').split('\n').map(l => l.trim()).find(Boolean) ?? 'no diagnostic';
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function walk(root: string, current: string, out: string[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (ALWAYS_SKIPPED.has(entry.name)) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) walk(root, path, out);
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(relative(root, path));
  }
}

/** POSIX ustar header. Names beyond the 100+155 split are refused, not truncated. */
function ustarHeader(path: string, size: number, type: '0' | '2', mode: number, link = ''): Buffer {
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 154);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100 || Buffer.byteLength(name.slice(0, cut)) > 155) {
      throw new CloudFlowError('sync_unsupported', `Path "${path}" is too long for the code sync archive.`);
    }
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  if (Buffer.byteLength(link) > 100) {
    throw new CloudFlowError('sync_unsupported', `Symlink target of "${path}" is too long for the code sync archive.`);
  }
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write(mode.toString(8).padStart(7, '0'), 100, 8);
  header.write('0000000', 108, 8);
  header.write('0000000', 116, 8);
  header.write(size.toString(8).padStart(11, '0'), 124, 12);
  header.write('00000000000', 136, 12);
  header.write('        ', 148, 8);
  header.write(type, 156, 1);
  header.write(link, 157, 100);
  header.write('ustar\0', 257, 6);
  header.write('00', 263, 2);
  header.write(prefix, 345, 155);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return header;
}

/** `PUT` the archive through the Cloud API; the run-scoped credential wins when present. */
export async function uploadCloudCode(
  prepared: PreparedCloudSync, packed: PackedTree, options: CloudConnectionOptions,
): Promise<void> {
  // The request needs a sized body, so the compressed archive is read back
  // once; that is the one copy that has to exist, and it is the small one.
  const tarball = await readFile(packed.archivePath);
  await cloudFetch(
    `/api/v1/workflows/runs/${encodeURIComponent(prepared.runId)}/storage/${encodeURIComponent(prepared.codeKey)}`,
    { ...options, requestTimeoutMs: options.requestTimeoutMs ?? 300_000 },
    { method: 'PUT', body: tarball, contentType: 'application/gzip',
      ...(prepared.uploadToken === undefined ? {} : { bearerToken: prepared.uploadToken }) },
  );
}

export interface CloudPatch {
  patch: string;
  hasChanges: boolean;
}

/** One entry of a multi-path run's patch map: the mounted path's name and its diff. */
export interface CloudPathPatch extends CloudPatch {
  name: string;
}

/**
 * What `/patch` answered, in both shapes the endpoint can produce.
 *
 * A run that declared mounted `paths` gets one `changes-<name>.patch` per path
 * and the route answers `{ patches: { <name>: { patch, hasChanges } } }`; every
 * other run gets `changes.patch` and the flat `{ patch, hasChanges }`. The
 * multi-path shape is not a v1 relic -- `paths` is orthogonal to
 * `relayflowVersion`, so a v2 run that submits several paths returns it too.
 */
export type CloudPatchSet =
  | { kind: 'single'; patch: string; hasChanges: boolean }
  | { kind: 'multi-path'; patches: readonly CloudPathPatch[]; hasChanges: boolean };

/**
 * The sandbox's post-run diff, in whichever shape the run produced.
 *
 * Both shapes are modelled rather than one refused at the transport, so a
 * caller can show a multi-path run's patches (`flows sync --dry-run`) before
 * deciding what to do with them. Applying them is still the caller's refusal
 * to make: they target different repositories and no single tree is the right
 * destination.
 */
export async function downloadCloudPatchSet(
  runId: string, options: CloudConnectionOptions,
): Promise<CloudPatchSet> {
  const payload = await cloudRequest(`/api/v1/workflows/runs/${encodeURIComponent(cloudRunId(runId))}/patch`, options);
  if (!isCloudRecord(payload)) throw new CloudFlowError('invalid_response', 'Cloud patch response was not an object.');
  if (isCloudRecord(payload.patches)) {
    const patches: CloudPathPatch[] = [];
    for (const [name, entry] of Object.entries(payload.patches)) {
      if (!isCloudRecord(entry) || typeof entry.patch !== 'string' || typeof entry.hasChanges !== 'boolean') {
        throw new CloudFlowError('invalid_response', `Cloud patch response has an unusable entry for path "${name}".`);
      }
      patches.push({ name, patch: entry.patch, hasChanges: entry.hasChanges });
    }
    return { kind: 'multi-path', patches, hasChanges: patches.some(entry => entry.hasChanges && entry.patch.trim() !== '') };
  }
  if (typeof payload.patch !== 'string' || typeof payload.hasChanges !== 'boolean') {
    throw new CloudFlowError('invalid_response', 'Cloud patch response is missing patch or hasChanges.');
  }
  return { kind: 'single', patch: payload.patch, hasChanges: payload.hasChanges };
}

/** The sandbox's post-run diff. Multi-path runs carry several patches and are refused here. */
export async function downloadCloudPatch(runId: string, options: CloudConnectionOptions): Promise<CloudPatch> {
  const set = await downloadCloudPatchSet(runId, options);
  if (set.kind === 'multi-path') {
    const names = set.patches.map(entry => entry.name);
    throw new CloudFlowError('sync_unsupported',
      `Run ${runId} produced ${names.length} path-scoped patches (${names.join(', ')}); flows sync applies single-tree runs only.`);
  }
  return { patch: set.patch, hasChanges: set.hasChanges };
}

/**
 * Paths a synced patch must never write, the single home for the list.
 *
 * These are the agent runtime's own bookkeeping inside a synced tree: helper
 * binaries staged for the sandbox, the relayfile mount's ACL and state files
 * (including the temporaries a mid-write state leaves behind), trajectory
 * records and workflow context. The sandbox commits its baseline before the
 * run, so every one of them shows up in the post-run diff as a creation or a
 * modification -- applying that diff verbatim drags the run's own plumbing into
 * the user's checkout, where at best it is noise in `git diff` and at worst it
 * overwrites the mount state of the tree being synced into.
 *
 * `git apply --exclude` matches these with wildmatch, anchored at the patch
 * root and with `*` stopping at a `/`: `.agent-bin/**` drops
 * `.agent-bin/nested/tool` but deliberately not `packages/x/.agent-bin/tool`,
 * which belongs to a different tree than the one being synced.
 */
export const CLOUD_SYNC_PATCH_EXCLUDES = [
  '.agent-bin/**',
  '.relayfile.acl',
  '.relayfile-mount-state.json',
  '.relayfile-mount-state.json.tmp-*',
  '.trajectories/**',
  '.workflow-context/**',
] as const;

/** The `a/` and `b/` sides of every `diff --git` header, in file order. */
function patchHeaders(patch: string): { old: string; new: string }[] {
  const headers: { old: string; new: string }[] = [];
  for (const match of patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gmu)) {
    headers.push({ old: match[1]!, new: match[2]! });
  }
  return headers;
}

/** Every path a unified diff touches, deletions included, in order of first appearance. */
export function patchedPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const header of patchHeaders(patch)) {
    for (const path of [header.old, header.new]) if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

/**
 * `git apply --exclude`'s wildmatch, as a matcher over a patch's own paths.
 *
 * Anchored at the patch root, `**` crosses `/` and `*`/`?` do not -- the subset
 * of wildmatch {@link CLOUD_SYNC_PATCH_EXCLUDES} uses. Kept honest by a test
 * that runs the same patterns through `git apply --numstat` and requires the
 * two answers to agree, so a divergence fails here rather than silently
 * reporting a path as dropped that git actually wrote.
 */
function matchesExclude(path: string, pattern: string): boolean {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*') {
      if (pattern[index + 1] === '*') { expression += '.*'; index += 1; continue; }
      expression += '[^/]*';
      continue;
    }
    expression += character === '?' ? '[^/]' : character.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`${expression}$`, 'u').test(path);
}

/**
 * The subset of a patch's paths `exclude` drops, in order of first appearance.
 *
 * Decided per `diff --git` header on its `b/` side, which is the name `git
 * apply` itself tests -- so a rename is dropped or kept whole, never half. A
 * deletion names the same path on both sides, so it is covered by the same rule.
 */
export function excludedPatchPaths(
  patch: string, exclude: readonly string[] = CLOUD_SYNC_PATCH_EXCLUDES,
): string[] {
  const paths: string[] = [];
  for (const header of patchHeaders(patch)) {
    if (!exclude.some(pattern => matchesExclude(header.new, pattern))) continue;
    for (const path of [header.old, header.new]) if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** Options for {@link applyCloudPatch}. */
export interface ApplyCloudPatchOptions {
  /**
   * Path patterns to drop, defaulting to {@link CLOUD_SYNC_PATCH_EXCLUDES}.
   * Pass `[]` to apply a patch whole -- including the runtime artifacts the
   * default list exists to keep out of a working tree.
   */
  exclude?: readonly string[];
}

/** What {@link applyCloudPatch} wrote, and what it dropped on the way. */
export interface AppliedCloudPatch {
  /** Paths the apply wrote, in order of first appearance in the patch. */
  files: string[];
  /** Paths `exclude` dropped, in order of first appearance in the patch. */
  excluded: string[];
}

/**
 * `git apply --check` then `git apply`; a conflict leaves the tree untouched.
 * The patch lands in the working tree uncommitted, so what the run changed is
 * reviewed with `git diff` before anything is kept -- the same contract as v1.
 *
 * Both invocations carry the identical `--exclude` arguments. A check run
 * without them is a different question than the apply answers: it can pass on
 * an excluded hunk that the apply then never writes, or fail on one and refuse
 * a patch whose applied part was clean. The exclusions are a property of the
 * patch that lands, so they belong to both halves or neither.
 *
 * A patch whose every path is excluded is a no-op, not a failure: `git apply`
 * exits 0 having written nothing, and the returned `files` is empty.
 */
export function applyCloudPatch(
  root: string, patch: string, options: ApplyCloudPatchOptions = {},
): AppliedCloudPatch {
  const exclude = options.exclude ?? CLOUD_SYNC_PATCH_EXCLUDES;
  const args = ['-C', resolve(root), 'apply', '--whitespace=nowarn',
    ...exclude.map(pattern => `--exclude=${pattern}`)];
  const check = spawnSync('git', [...args, '--check'], { input: patch, encoding: 'utf8' });
  if (check.status !== 0) {
    throw new CloudFlowError('patch_conflict',
      `The patch does not apply cleanly to ${resolve(root)}:\n${check.stderr.trim()}`);
  }
  const apply = spawnSync('git', args, { input: patch, encoding: 'utf8' });
  if (apply.status !== 0) {
    throw new CloudFlowError('patch_conflict', `git apply failed:\n${apply.stderr.trim()}`);
  }
  const excluded = excludedPatchPaths(patch, exclude);
  return { files: patchedPaths(patch).filter(path => !excluded.includes(path)), excluded };
}
