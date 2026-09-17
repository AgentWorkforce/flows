import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
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
  tarball: Buffer;
  /** Archive members, `root`-relative POSIX paths, sorted. */
  files: string[];
  /** Uncompressed byte total across regular files. */
  bytes: number;
}

/**
 * gzip'd ustar of the working tree at `root`. Inside a Git checkout the member
 * list is `git ls-files --cached --others --exclude-standard`, so `.gitignore`
 * governs and untracked-but-not-ignored files ride along, as they do in v1.
 * Outside Git, every regular file and symlink except `.git`/`node_modules`.
 * Ordering and mtimes are deterministic, so the same tree packs to the same
 * bytes; what Cloud extracts is exactly this list, nothing implicit.
 */
export function packWorkingTree(root: string): PackedTree {
  const absoluteRoot = resolve(root);
  const files = listTreeFiles(absoluteRoot);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for (const path of files) {
    const absolute = join(absoluteRoot, ...path.split('/'));
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      chunks.push(ustarHeader(path, 0, '2', readlinkSync(absolute)));
      continue;
    }
    if (!stat.isFile()) continue;
    bytes += stat.size;
    if (bytes > MAX_SYNC_BYTES) {
      throw new CloudFlowError('sync_too_large',
        `The working tree exceeds the ${MAX_SYNC_BYTES}-byte code sync limit; narrow it with .gitignore.`);
    }
    const content = readFileSync(absolute);
    chunks.push(ustarHeader(path, content.length, '0'), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return { tarball: gzipSync(Buffer.concat(chunks), { level: 6 }), files, bytes };
}

function listTreeFiles(root: string): string[] {
  const git = spawnSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let candidates: string[];
  if (git.status === 0) {
    candidates = git.stdout.split('\0').filter(Boolean);
  } else {
    candidates = [];
    walk(root, root, candidates);
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

function walk(root: string, current: string, out: string[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (ALWAYS_SKIPPED.has(entry.name)) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) walk(root, path, out);
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(relative(root, path));
  }
}

/** POSIX ustar header. Names beyond the 100+155 split are refused, not truncated. */
function ustarHeader(path: string, size: number, type: '0' | '2', link = ''): Buffer {
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
  header.write(type === '2' ? '0000777' : '0000644', 100, 8);
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
  prepared: PreparedCloudSync, tarball: Buffer, options: CloudConnectionOptions,
): Promise<void> {
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

/** The sandbox's post-run diff. Multi-path runs carry several patches and are refused here. */
export async function downloadCloudPatch(runId: string, options: CloudConnectionOptions): Promise<CloudPatch> {
  const payload = await cloudRequest(`/api/v1/workflows/runs/${encodeURIComponent(cloudRunId(runId))}/patch`, options);
  if (!isCloudRecord(payload)) throw new CloudFlowError('invalid_response', 'Cloud patch response was not an object.');
  if (isCloudRecord(payload.patches)) {
    const names = Object.keys(payload.patches);
    throw new CloudFlowError('sync_unsupported',
      `Run ${runId} produced ${names.length} path-scoped patches (${names.join(', ')}); flows sync applies single-tree runs only.`);
  }
  if (typeof payload.patch !== 'string' || typeof payload.hasChanges !== 'boolean') {
    throw new CloudFlowError('invalid_response', 'Cloud patch response is missing patch or hasChanges.');
  }
  return { patch: payload.patch, hasChanges: payload.hasChanges };
}

/** `git apply --check` then `git apply`; a conflict leaves the tree untouched. */
export function applyCloudPatch(root: string, patch: string): void {
  const args = ['-C', resolve(root), 'apply', '--whitespace=nowarn'];
  const check = spawnSync('git', [...args, '--check'], { input: patch, encoding: 'utf8' });
  if (check.status !== 0) {
    throw new CloudFlowError('patch_conflict',
      `The patch does not apply cleanly to ${resolve(root)}:\n${check.stderr.trim()}`);
  }
  const apply = spawnSync('git', args, { input: patch, encoding: 'utf8' });
  if (apply.status !== 0) {
    throw new CloudFlowError('patch_conflict', `git apply failed:\n${apply.stderr.trim()}`);
  }
}
