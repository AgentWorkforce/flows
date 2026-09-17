import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { runInCloud } from '../src/cloud-run.js';
import { applyCloudPatch, packWorkingTree, patchedPaths, prepareCloudSync } from '../src/cloud-sync.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

interface Call { method: string; path: string; auth: string | undefined; contentType: string | null; body: unknown }

/** Records every request; `routes` answers by path prefix. */
function cloud(routes: Record<string, (call: Call) => unknown>) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    init?.signal?.throwIfAborted();
    const headers = new Headers(init?.headers);
    const path = new URL(String(input)).pathname;
    const raw = init?.body;
    const body = raw === undefined ? undefined
      : typeof raw === 'string' ? JSON.parse(raw)
      : Buffer.from(await new Response(raw as BodyInit).arrayBuffer());
    const call: Call = { method: init?.method ?? 'GET', path, auth: headers.get('authorization') ?? undefined,
      contentType: headers.get('content-type'), body };
    calls.push(call);
    const route = Object.keys(routes).find(prefix => path.startsWith(prefix));
    if (!route) return new Response('{"error":"not found"}', { status: 404 });
    return new Response(JSON.stringify(routes[route]!(call)), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubEnv('FLOWS_CLOUD_URL', 'https://cloud-contract.example');
  vi.stubEnv('FLOWS_CLOUD_TOKEN', 'test-scoped-cloud-token');
  return { calls, options: { apiUrl: 'https://cloud-contract.example', token: 'test-scoped-cloud-token' } };
}

const PREPARED = {
  runId: 'prepared-run', s3CodeKey: 'code.tar.gz',
  workflowStorage: { backend: 'cloud-api' },
  s3Credentials: { backend: 'cloud-api', cloudApiAccessToken: 'run-scoped-upload-token' },
};

async function untar(tarball: Buffer): Promise<{ dir: string; members: string[] }> {
  const dir = await tempDir('cloud-sync-extract-');
  await writeFile(join(dir, 'code.tar.gz'), tarball);
  const members = execFileSync('tar', ['-tzf', join(dir, 'code.tar.gz')], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
  await mkdir(join(dir, 'out'));
  execFileSync('tar', ['-xzf', join(dir, 'code.tar.gz'), '-C', join(dir, 'out')]);
  return { dir: join(dir, 'out'), members };
}

/** Pack, read the spooled archive once, and dispose it, as the upload path does. */
async function pack(root: string) {
  const packed = await packWorkingTree(root);
  try {
    return { ...packed, tarball: await readFile(packed.archivePath) };
  } finally {
    packed.dispose();
  }
}

describe('packWorkingTree', () => {
  it('packs a Git checkout by ls-files semantics: tracked plus untracked, never ignored, .git or node_modules', async () => {
    const root = await tempDir('cloud-sync-git-');
    git(root, 'init', '-q');
    await mkdir(join(root, 'src/deep'), { recursive: true });
    await mkdir(join(root, 'node_modules/dep'), { recursive: true });
    await writeFile(join(root, 'src/deep/a.ts'), 'export const a = 1;\n');
    await writeFile(join(root, 'node_modules/dep/index.js'), 'ignored by rule\n');
    await writeFile(join(root, '.gitignore'), 'dist/\n*.log\n');
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist/build.js'), 'ignored\n');
    await writeFile(join(root, 'debug.log'), 'ignored\n');
    await symlink('src/deep/a.ts', join(root, 'link.ts'));
    await symlink('/etc/hosts', join(root, 'escape-abs'));
    await symlink('../../outside', join(root, 'escape-rel'));
    await writeFile(join(root, 'run.sh'), '#!/bin/sh\necho ok\n');
    await chmod(join(root, 'run.sh'), 0o755);
    git(root, 'add', '.gitignore', 'src', 'run.sh');
    git(root, 'commit', '-q', '-m', 'baseline');
    await writeFile(join(root, 'untracked.md'), 'rides along\n');

    const packed = await pack(root);
    expect(packed.files).toEqual(['.gitignore', 'link.ts', 'run.sh', 'src/deep/a.ts', 'untracked.md']);
    expect(packed.skippedLinks).toEqual(['escape-abs', 'escape-rel']);
    expect(packed.bytes).toBe(Buffer.byteLength('dist/\n*.log\n') + Buffer.byteLength('export const a = 1;\n')
      + Buffer.byteLength('#!/bin/sh\necho ok\n') + Buffer.byteLength('rides along\n'));

    const { dir, members } = await untar(packed.tarball);
    expect(members).toEqual(['.gitignore', 'link.ts', 'run.sh', 'src/deep/a.ts', 'untracked.md']);
    expect(await readFile(join(dir, 'src/deep/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(await readFile(join(dir, 'link.ts'), 'utf8')).toBe('export const a = 1;\n');
    // Executable bits survive the round trip; plain files stay 0644.
    expect((await stat(join(dir, 'run.sh'))).mode & 0o111).not.toBe(0);
    expect((await stat(join(dir, 'src/deep/a.ts'))).mode & 0o111).toBe(0);
    expect((await promisify(execFile)(join(dir, 'run.sh'))).stdout).toBe('ok\n');
    expect(await readdir(dir)).not.toContain('node_modules');
    expect(await readdir(dir)).not.toContain('escape-abs');
  });

  it('refuses to widen to a walk when git fails inside a checkout', async () => {
    const root = await tempDir('cloud-sync-gitfail-');
    git(root, 'init', '-q');
    await writeFile(join(root, '.gitignore'), '.env\n');
    await writeFile(join(root, '.env'), 'SECRET=1\n');
    await writeFile(join(root, 'ok.txt'), 'ok\n');
    // A locked index makes ls-files fail while rev-parse still says "inside".
    await writeFile(join(root, '.git/index.lock'), '');
    const broken = await tempDir('cloud-sync-gitbroken-');
    await mkdir(join(broken, '.git'));
    await writeFile(join(broken, '.git/HEAD'), 'garbage\n');
    await writeFile(join(broken, '.env'), 'SECRET=1\n');
    // A corrupt .git is refused outright. A locked index is refused where git
    // refuses ls-files; a git that tolerates the lock must still honour .gitignore.
    await expect(pack(broken)).rejects.toMatchObject({ code: 'sync_unsupported' });
    let error: unknown;
    try { await pack(root); } catch (e) { error = e; }
    if (error === undefined) expect((await pack(root)).files).not.toContain('.env');
    else {
      expect(error).toMatchObject({ code: 'sync_unsupported' });
      expect(String((error as Error).message)).not.toContain('SECRET');
    }
  });

  it('keeps in-tree symlinks whose names merely start with dots, and refuses git-less subdirectories of a checkout', async () => {
    const root = await tempDir('cloud-sync-dotlink-');
    await mkdir(join(root, '..cache'));
    await writeFile(join(root, '..cache/file'), 'cached');
    await symlink('..cache/file', join(root, 'dotlink'));
    const packed = await pack(root);
    expect(packed.files).toEqual(['..cache/file', 'dotlink']);
    expect(packed.skippedLinks).toEqual([]);

    // A subdirectory of a broken checkout has no .git of its own; the parent's
    // unreadable one must still stop the walk from uploading ignored files.
    const repo = await tempDir('cloud-sync-broken-parent-');
    await mkdir(join(repo, '.git'));
    await writeFile(join(repo, '.git/HEAD'), 'garbage\n');
    await mkdir(join(repo, 'sub'));
    await writeFile(join(repo, 'sub/.env'), 'SECRET=1\n');
    await expect(pack(join(repo, 'sub'))).rejects.toMatchObject({ code: 'sync_unsupported' });

    // Without git at all, a tree with a .git anywhere above is refused; a plain one walks.
    const path = process.env['PATH'];
    vi.stubEnv('PATH', '/nonexistent');
    try {
      const plain = await tempDir('cloud-sync-nogit-plain-');
      await writeFile(join(plain, 'a.txt'), 'a');
      expect((await pack(plain)).files).toEqual(['a.txt']);
      await expect(pack(join(repo, 'sub'))).rejects.toMatchObject({ code: 'sync_unsupported' });
    } finally {
      vi.stubEnv('PATH', path ?? '');
    }
  });

  it('packs a plain directory by walking it, skipping node_modules and nested .git entries', async () => {
    const root = await tempDir('cloud-sync-plain-');
    await mkdir(join(root, 'lib'));
    await mkdir(join(root, 'node_modules'));
    // A vendored checkout inside a plain directory: its .git is skipped, its files ride along.
    await mkdir(join(root, 'vendor/.git'), { recursive: true });
    await writeFile(join(root, 'lib/x.txt'), 'x');
    await writeFile(join(root, 'node_modules/y.txt'), 'y');
    await writeFile(join(root, 'vendor/.git/HEAD'), 'ref');
    await writeFile(join(root, 'vendor/v.txt'), 'v');
    await writeFile(join(root, 'top.txt'), 'top');
    const packed = await pack(root);
    expect(packed.files).toEqual(['lib/x.txt', 'top.txt', 'vendor/v.txt']);
    expect((await untar(packed.tarball)).members).toEqual(['lib/x.txt', 'top.txt', 'vendor/v.txt']);
  });

  it('is deterministic for the same tree', async () => {
    const root = await tempDir('cloud-sync-det-');
    await writeFile(join(root, 'a'), 'a');
    expect((await pack(root)).tarball.equals((await pack(root)).tarball)).toBe(true);
  });

  it('disposes its spool file after packing', async () => {
    const root = await tempDir('cloud-sync-spool-');
    await writeFile(join(root, 'a'), 'a');
    const packed = await packWorkingTree(root);
    expect((await stat(packed.archivePath)).size).toBeGreaterThan(0);
    packed.dispose();
    await expect(stat(packed.archivePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('prepareCloudSync', () => {
  it('refuses a non-Cloud-API storage backend before anything is uploaded', async () => {
    const { calls, options } = cloud({
      '/api/v1/workflows/prepare': () => ({
        runId: 'aws-run', s3CodeKey: 'code.tar.gz',
        s3Credentials: { backend: 's3', accessKeyId: 'AKIA', secretAccessKey: 'x', bucket: 'b', prefix: 'p' },
      }),
    });
    await expect(prepareCloudSync(options)).rejects.toMatchObject({ code: 'unsupported_storage_backend' });
    expect(calls.map(call => call.method)).toEqual(['POST']);
  });

  it('accepts the Cloud-API backend and surfaces the run-scoped upload token', async () => {
    const { options } = cloud({ '/api/v1/workflows/prepare': () => PREPARED });
    expect(await prepareCloudSync(options)).toEqual({
      runId: 'prepared-run', codeKey: 'code.tar.gz', uploadToken: 'run-scoped-upload-token',
    });
  });
});

describe('runInCloud with syncCode', () => {
  it('prepares, uploads through the Cloud API with the run-scoped token, then submits against the prepared run', async () => {
    const root = await tempDir('cloud-sync-run-');
    await writeFile(join(root, 'flow.yaml'), JSON.stringify({
      version: '0.1.0', name: 'synced', steps: [{ id: 'ls', type: 'deterministic', command: 'ls' }],
    }));
    await writeFile(join(root, 'data.txt'), 'payload\n');
    const { calls, options } = cloud({
      '/api/v1/workflows/prepare': () => PREPARED,
      '/api/v1/workflows/runs/prepared-run/storage/code.tar.gz': () => ({ ok: true }),
      '/api/v1/workflows/run': () => ({ runId: 'prepared-run', status: 'pending' }),
    });

    const receipt = await runInCloud({ path: join(root, 'flow.yaml') }, { ...options, syncCode: { root } });

    expect(calls.map(call => [call.method, call.path])).toEqual([
      ['POST', '/api/v1/workflows/prepare'],
      ['PUT', '/api/v1/workflows/runs/prepared-run/storage/code.tar.gz'],
      ['POST', '/api/v1/workflows/run'],
    ]);
    const upload = calls[1]!;
    expect(upload.auth).toBe('Bearer run-scoped-upload-token');
    expect(upload.contentType).toBe('application/gzip');
    const tar = gunzipSync(upload.body as Buffer).toString('latin1');
    expect(tar).toContain('data.txt');
    expect(tar).toContain('flow.yaml');
    expect(calls[2]!.auth).toBe('Bearer test-scoped-cloud-token');
    expect(calls[2]!.body).toMatchObject({ runId: 'prepared-run', s3CodeKey: 'code.tar.gz', relayflowVersion: 'v2' });
    expect(receipt).toMatchObject({ runId: 'prepared-run', synced: { files: 2 } });
  });

  it('refuses an accepted run whose ID differs from the prepared upload', async () => {
    const root = await tempDir('cloud-sync-mismatch-');
    await writeFile(join(root, 'flow.yaml'), JSON.stringify({
      version: '0.1.0', name: 'synced', steps: [{ id: 'ls', type: 'deterministic', command: 'ls' }],
    }));
    const { options } = cloud({
      '/api/v1/workflows/prepare': () => PREPARED,
      '/api/v1/workflows/runs/prepared-run/storage/code.tar.gz': () => ({ ok: true }),
      '/api/v1/workflows/run': () => ({ runId: 'someone-else', status: 'pending' }),
    });
    await expect(runInCloud({ path: join(root, 'flow.yaml') }, { ...options, syncCode: { root } }))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('never submits when the backend is refused', async () => {
    const root = await tempDir('cloud-sync-refused-');
    await writeFile(join(root, 'flow.yaml'), JSON.stringify({
      version: '0.1.0', name: 'synced', steps: [{ id: 'ls', type: 'deterministic', command: 'ls' }],
    }));
    const { calls, options } = cloud({
      '/api/v1/workflows/prepare': () => ({ runId: 'r', s3CodeKey: 'code.tar.gz', s3Credentials: { backend: 's3' } }),
    });
    await expect(runInCloud({ path: join(root, 'flow.yaml') }, { ...options, syncCode: { root } }))
      .rejects.toMatchObject({ code: 'unsupported_storage_backend' });
    expect(calls.map(call => call.path)).toEqual(['/api/v1/workflows/prepare']);
  });
});

describe('flows run --cloud --sync-code / flows sync', () => {
  it('runs an authored flow with --input and syncs the invoking directory', async () => {
    const root = await tempDir('cloud-sync-cli-');
    await symlink(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'dir');
    await writeFile(join(root, 'review.flow.ts'), "import { flow } from '@relayflows/surface';\n"
      + "export default flow('review', async f => f.done('success'));\n");
    await writeFile(join(root, 'notes.md'), 'context\n');
    const { calls } = cloud({
      '/api/v1/workflows/prepare': () => PREPARED,
      '/api/v1/workflows/runs/prepared-run/storage/code.tar.gz': () => ({ ok: true }),
      '/api/v1/workflows/run': () => ({ runId: 'prepared-run', status: 'pending' }),
    });
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    const output: string[] = [];
    const code = await runCli(['run', '--cloud', '--sync-code', '--json', '--input', '{"pr":7}', join(root, 'review.flow.ts')],
      { stdout: line => output.push(line), stderr: line => output.push(line) });
    cwd.mockRestore();
    expect(code, output.join('\n')).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ ok: true, runId: 'prepared-run', synced: { files: 2 } });
    expect(calls[2]!.body).toMatchObject({ fileType: 'ts', inputs: { pr: 7 }, runId: 'prepared-run', s3CodeKey: 'code.tar.gz' });
    const tar = gunzipSync(calls[1]!.body as Buffer).toString('latin1');
    expect(tar).toContain('notes.md');
    expect(tar).not.toContain('node_modules');
  });

  it.each([
    ['run', '--sync-code', 'flow.yaml'],
    ['run', '--cloud', '--sync-code', '--sync-code', 'flow.yaml'],
    ['run', '--cloud', '--input', '{}', 'flow.yaml'],
    ['sync'], ['sync', 'a', 'b'], ['sync', '--dir'], ['sync', '--json', '--json', 'r'],
  ])('refuses argv %j before any request', async (...args) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect(await runCli(args, { stdout: () => {}, stderr: () => {} })).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('applies a single-tree patch and reports the files', async () => {
    const root = await tempDir('cloud-sync-apply-');
    git(root, 'init', '-q');
    await writeFile(join(root, 'a.txt'), 'one\n');
    git(root, 'add', 'a.txt');
    git(root, 'commit', '-q', '-m', 'baseline');
    await writeFile(join(root, 'gone.txt'), 'bye\n');
    git(root, 'add', 'gone.txt');
    git(root, 'commit', '-q', '-m', 'add gone');
    const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1,2 @@\n one\n+two\n'
      + 'diff --git a/b.txt b/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+fresh\n'
      + 'diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n';
    cloud({ '/api/v1/workflows/runs/done-run/patch': () => ({ patch, hasChanges: true }) });
    const output: string[] = [];
    expect(await runCli(['sync', '--json', '--dir', root, 'done-run'], { stdout: line => output.push(line), stderr: line => output.push(line) })).toBe(0);
    expect(JSON.parse(output[0]!)).toEqual({ ok: true, runId: 'done-run', hasChanges: true, applied: true, files: ['a.txt', 'b.txt', 'gone.txt'] });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('fresh\n');
    await expect(stat(join(root, 'gone.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(patchedPaths(patch)).toEqual(['a.txt', 'b.txt', 'gone.txt']);
  });

  it('classifies an interruption during upload as pre-admission, not admission_unknown', async () => {
    const root = await tempDir('cloud-sync-abort-');
    await writeFile(join(root, 'flow.yaml'), JSON.stringify({
      version: '0.1.0', name: 'synced', steps: [{ id: 'ls', type: 'deterministic', command: 'ls' }],
    }));
    const { calls } = cloud({
      '/api/v1/workflows/prepare': () => { process.emit('SIGINT'); return PREPARED; },
      '/api/v1/workflows/runs/prepared-run/storage/code.tar.gz': () => ({ ok: true }),
      '/api/v1/workflows/run': () => ({ runId: 'prepared-run', status: 'pending' }),
    });
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    const output: string[] = [];
    const code = await runCli(['run', '--cloud', '--sync-code', '--json', join(root, 'flow.yaml')],
      { stdout: line => output.push(line), stderr: () => {} });
    cwd.mockRestore();
    expect(code).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ ok: false, code: 'submission_aborted' });
    expect(calls.map(c => c.path)).not.toContain('/api/v1/workflows/run');
  });

  it('reports no changes without touching the tree', async () => {
    const root = await tempDir('cloud-sync-none-');
    cloud({ '/api/v1/workflows/runs/quiet/patch': () => ({ patch: '', hasChanges: false }) });
    const output: string[] = [];
    expect(await runCli(['sync', '--dir', root, 'quiet'], { stdout: line => output.push(line), stderr: () => {} })).toBe(0);
    expect(output).toEqual(['NO CHANGES quiet']);
  });

  it('refuses multi-path patches and conflicting patches without partial application', async () => {
    const root = await tempDir('cloud-sync-conflict-');
    git(root, 'init', '-q');
    await writeFile(join(root, 'a.txt'), 'one\n');
    git(root, 'add', 'a.txt');
    git(root, 'commit', '-q', '-m', 'baseline');
    cloud({ '/api/v1/workflows/runs/multi/patch': () => ({ patches: { api: { patch: 'x', hasChanges: true }, web: { patch: 'y', hasChanges: true } } }) });
    const errors: string[] = [];
    expect(await runCli(['sync', '--dir', root, 'multi'], { stdout: () => {}, stderr: line => errors.push(line) })).toBe(2);
    expect(errors[0]).toContain('sync_unsupported');
    expect(() => applyCloudPatch(root, 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-nope\n+two\n'))
      .toThrow(expect.objectContaining({ code: 'patch_conflict' }));
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\n');
  });
});
