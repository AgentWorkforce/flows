import { constants } from 'node:fs';
import { access, cp, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { verifyBundle } from './bundle.js';

export type BundleFailureKind = 'bucket_unconfigured' | 'bucket_unreachable'
  | 'bundle_missing_locally' | 'bundle_signature_invalid' | 'bundle_unsupported' | 'deploy_partial';
export class BundleFailure extends Error {
  constructor(readonly kind: BundleFailureKind, message: string) { super(message); }
}
export interface DigestReference { name: string; digest: string }
export function parseDigestReference(value: string): DigestReference | undefined {
  const match = /^([a-z][a-z0-9-]*)@sha256:([0-9a-f]{64})$/.exec(value);
  return match ? { name: match[1]!, digest: match[2]! } : undefined;
}
export function bucketDirectory(uri: string, ref: DigestReference): string {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:' || url.search || url.hash) throw new Error('expected file:// URI');
    const path = fileURLToPath(url);
    if (!isAbsolute(path)) throw new Error('expected absolute bucket path');
    return join(path, ref.name, 'sha256', ref.digest);
  } catch {
    throw new BundleFailure('bucket_unreachable', 'This slice requires an absolute file:// bucket URI.');
  }
}
export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function verifyDigest(directory: string, digest: string): Promise<void> {
  try { await verifyBundle(directory, digest); }
  catch (error) { throw new BundleFailure('bundle_signature_invalid', String(error)); }
}
/** Publish only a complete, verified directory. Concurrent identical writers converge. */
export async function copyBundle(source: string, target: string, digest: string): Promise<boolean> {
  if (await exists(target)) { await verifyDigest(target, digest); return false; }
  await mkdir(dirname(target), { recursive: true });
  const staging = await mkdtemp(join(dirname(target), '.bundle-'));
  try {
    await cp(source, staging, { recursive: true, dereference: false, verbatimSymlinks: true });
    await verifyDigest(staging, digest);
    try { await rename(staging, target); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await verifyDigest(target, digest);
      return false;
    }
    return true;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
export async function writableBucket(target: string): Promise<void> {
  try {
    await mkdir(dirname(target), { recursive: true });
    await access(dirname(target), constants.W_OK);
    const probe = await mkdtemp(join(dirname(target), '.probe-'));
    await rm(probe, { recursive: true });
  } catch (error) { throw new BundleFailure('bucket_unreachable', String(error)); }
}
export async function fetchBundle(ref: DigestReference, bucket: string): Promise<string> {
  const cacheRoot = process.env['XDG_CACHE_HOME'];
  const cache = join(cacheRoot && isAbsolute(cacheRoot) ? cacheRoot : join(homedir(), '.cache'),
    'flows', 'bundles', ref.digest);
  // Verify every hit; a corrupt cache never executes or silently falls back.
  if (await exists(cache)) { await verifyDigest(cache, ref.digest); return cache; }
  const source = bucketDirectory(bucket, ref);
  try {
    if (!await exists(source)) throw new BundleFailure('bucket_unreachable', `Bundle is absent at ${bucket}.`);
    await verifyDigest(source, ref.digest);
    await copyBundle(source, cache, ref.digest);
    return cache;
  } catch (error) {
    if (error instanceof BundleFailure) throw error;
    throw new BundleFailure('bucket_unreachable', String(error));
  }
}
