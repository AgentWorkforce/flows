import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalize } from './canonical.js';

export interface BundleEntry { path: string; sha256: string; bytes: number }
export interface BundleFile { path: string; data: Uint8Array | string; executable?: boolean }
export interface BundleOptions {
  name: string;
  out: string;
  repo: string;
  files: BundleFile[];
  env?: NodeJS.ProcessEnv;
  warn(message: string): void;
}

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function safePath(path: string): boolean {
  return path.length > 0 && !path.includes('\\') && !path.includes('\0')
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
    && !path.includes(':');
}

/** Manifest and identity are envelopes, excluded to avoid circular hashing. */
export async function sealBundle(options: BundleOptions): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.name)) {
    throw new Error('spec.canonical.json: name must be a safe single directory component');
  }
  const files = options.files.map(file => ({ ...file, data: Buffer.from(file.data) }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const paths = new Set<string>();
  for (const file of files) {
    if (!safePath(file.path) || ['manifest.json', 'identity.json'].includes(file.path) || paths.has(file.path)) {
      throw new Error(`${file.path}: invalid or duplicate bundle path`);
    }
    paths.add(file.path);
  }
  for (const required of ['spec.canonical.json', 'preflight.json', 'lockfile.json']) {
    if (!paths.has(required)) throw new Error(`${required}: missing bundle file`);
  }
  const manifest = canonicalize(files.map(file => ({
    path: file.path, sha256: sha256(file.data), bytes: file.data.length,
  })));
  const digest = sha256(manifest);
  const out = resolve(options.out);
  const target = join(out, `${options.name}@sha256:${digest}`);
  let exists = false;
  try { await lstat(target); exists = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (exists) { await verifyBundle(target); return target; }
  const identity = await signDigest(digest, options);
  await mkdir(out, { recursive: true });
  const staging = await mkdtemp(join(out, '.build-'));
  try {
    for (const file of files) {
      await mkdir(dirname(join(staging, file.path)), { recursive: true });
      await writeFile(join(staging, file.path), file.data, { mode: file.path === 'flow' || file.executable ? 0o755 : 0o644 });
    }
    await writeFile(join(staging, 'manifest.json'), manifest);
    await writeFile(join(staging, 'identity.json'), canonicalize(identity));
    try { await rename(staging, target); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await verifyBundle(target);
    }
    return target;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function signDigest(digest: string, options: BundleOptions) {
  let seedText = (options.env ?? process.env)['FLOWS_BUILD_KEY'];
  if (seedText === undefined) {
    try { seedText = (await readFile(join(options.repo, '.flows/build.key'), 'utf8')).trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  let seed: Buffer;
  if (seedText === undefined) {
    options.warn('identity_ephemeral: bundle can be verified but not attributed');
    seed = randomBytes(32);
  } else {
    seed = Buffer.from(seedText, 'base64');
    if (seed.length !== 32 || seed.toString('base64') !== seedText) {
      throw new Error('build key: expected a base64-encoded 32-byte seed');
    }
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der', type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    algorithm: 'ed25519', keyid: sha256(publicKey).slice(0, 16), pubkey_b64: publicKey.toString('base64'),
    signature_hex: sign(null, Buffer.from(digest, 'hex'), privateKey).toString('hex'),
  };
}

async function regularFile(root: string, path: string): Promise<Buffer> {
  try {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const stat = await lstat(join(root, ...parts.slice(0, i)));
      if (i === parts.length ? !stat.isFile() : !stat.isDirectory()) {
        throw new Error('expected a regular file, without symlinks');
      }
    }
    return await readFile(join(root, path));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : 'unreadable'}`);
  }
}

/** Verify an untrusted directory without following symlinks or manifest traversal.
 * Bucket/cache readers supply the requested digest; local builds bind it to the directory name. */
export async function verifyBundle(directory: string, expectedDigest?: string): Promise<string> {
  const root = resolve(directory);
  if (!(await lstat(root)).isDirectory()) throw new Error('manifest.json: bundle must be a directory, not a symlink');
  const raw = (await regularFile(root, 'manifest.json')).toString('utf8');
  let manifest: BundleEntry[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected an array');
    manifest = parsed;
  } catch { throw new Error('manifest.json: invalid manifest'); }
  const paths = new Set<string>();
  let previous = '';
  for (const entry of manifest) {
    if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string'
      || !safePath(entry.path) || entry.path <= previous
      || ['manifest.json', 'identity.json'].includes(entry.path)
      || Object.keys(entry).sort().join(',') !== 'bytes,path,sha256'
      || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error('manifest.json: invalid, duplicate, or unsorted entry');
    }
    previous = entry.path;
    paths.add(entry.path);
    const bytes = await regularFile(root, entry.path);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new Error(`${entry.path}: sha256 or byte count mismatch`);
    }
  }
  for (const required of ['spec.canonical.json', 'preflight.json', 'lockfile.json']) {
    if (!paths.has(required)) throw new Error(`${required}: missing manifest entry`);
  }
  const canonical = canonicalize(manifest);
  if (raw !== canonical) throw new Error('manifest.json: noncanonical bytes');
  const digest = sha256(canonical);
  const matchesDigest = expectedDigest === undefined
    ? basename(root).endsWith(`@sha256:${digest}`) : digest === expectedDigest;
  if (!matchesDigest) throw new Error('manifest.json: directory digest mismatch');
  await rejectExtras(root, '', new Set([...paths, 'manifest.json', 'identity.json']));
  try {
    const identity = JSON.parse((await regularFile(root, 'identity.json')).toString('utf8'));
    const publicKey = Buffer.from(identity.pubkey_b64, 'base64');
    if (identity.algorithm !== 'ed25519' || publicKey.length !== 32
      || publicKey.toString('base64') !== identity.pubkey_b64
      || identity.keyid !== sha256(publicKey).slice(0, 16)
      || !/^[a-f0-9]{128}$/.test(identity.signature_hex)) throw new Error('invalid identity');
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]), format: 'der', type: 'spki',
    });
    if (!verify(null, Buffer.from(digest, 'hex'), key, Buffer.from(identity.signature_hex, 'hex'))) {
      throw new Error('signature mismatch');
    }
  } catch (error) {
    throw new Error(`identity.json: ${error instanceof Error ? error.message : 'signature verification failed'}`);
  }
  return digest;
}

async function rejectExtras(root: string, prefix: string, paths: Set<string>): Promise<void> {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory() && [...paths].some(file => file.startsWith(`${path}/`))) {
      await rejectExtras(root, `${path}/`, paths);
    } else if (!entry.isFile() || !paths.has(path)) {
      throw new Error(`${path}: unlisted file or unsupported file type`);
    }
  }
}
