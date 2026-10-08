import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerCloudFlow, CloudAnswerError } from '../src/cloud-answer.js';
import { runCli } from '../src/cli.js';
import { packageTreeSha256 } from '../src/authored-flow-loader.js';

const RUN = '2e97a7ed';
const path = `/api/v1/workflows/runs/${RUN}`;
// This is deliberately not executable TypeScript: resuming must only read bytes.
const workflow = 'original UTF-8 source 🛰️; do not execute';
const surface = { packageName: '@relayflows/surface', version: '2.0.18',
  packageSha256: 'a'.repeat(64), runtimeSha256: 'b'.repeat(64) };
const sourceSha256 = createHash('sha256').update(workflow).digest('hex');
// The stored attestation shape, which differs from the submission authority.
const authority = { source: { sha256: sourceSha256, surface }, artifact: { sha256: 'original-artifact' } };
const submitted = { schemaVersion: 1, sourceSha256, byteLength: Buffer.byteLength(workflow), surface };
const wait = { waitId: 'human-2', question: 'Ship this?', to: 'slack:#eng' };
const parked = { runId: RUN, relayflowVersion: 'v2', status: 'failed', workflow,
  relayflowV2Authority: authority, workspaceId: 'original-workspace',
  result: { completionReason: 'needs_human', humanWait: wait } };
const options = { apiUrl: 'https://cloud.example', token: 'test-cloud-token' };
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
interface Reply { body: unknown; status?: number }
function cloud(replies: Reply[]) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ method: init!.method!, path: new URL(String(url)).pathname,
      ...(init!.body ? { body: JSON.parse(String(init!.body)) } : {}) });
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected request');
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  });
  return calls;
}
function replies(record = parked): Reply[] {
  return [{ body: record }, { body: { humanWait: wait } }, { body: { ok: true } },
    { body: record }, { body: { runId: 'resumed-1', status: 'pending' } }];
}
function capture() {
  const stdout: string[] = [], stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (s: string) => stdout.push(s), stderr: (s: string) => stderr.push(s) } };
}
function env() {
  vi.stubEnv('FLOWS_CLOUD_URL', options.apiUrl); vi.stubEnv('FLOWS_CLOUD_TOKEN', options.token);
}

describe('Cloud answer and resume', () => {
  it('discovers the wait, answers, rechecks and resumes using original authority without inputs', async () => {
    const calls = cloud(replies());
    expect(await answerCloudFlow(RUN, true, { ...options, note: 'reviewed' })).toEqual({
      runId: 'resumed-1', resumedFrom: RUN, waitId: 'human-2', answer: true, resumedByCloud: false,
    });
    expect(calls.map(c => [c.method, c.path])).toEqual([
      ['GET', path], ['GET', `${path}/answer`], ['POST', `${path}/answer`], ['GET', path], ['POST', '/api/v1/workflows/run'],
    ]);
    expect(calls[2]!.body).toEqual({ waitId: 'human-2', answer: true, note: 'reviewed' });
    expect(calls[4]!.body).toEqual({ workflow, authoredAuthority: submitted, fileType: 'ts',
      relayflowVersion: 'v2', resume: RUN, workspaceId: 'original-workspace' });
    expect(calls[4]!.body).not.toHaveProperty('inputs');
  });

  it.each([
    ['truncated source', { workflow: workflow.slice(0, 10) }],
    ['missing digest', { relayflowV2Authority: { source: {} } }],
    ['synced tree', { s3CodeKey: 'code/original.tar' }],
    ['sync marker', { syncCode: true }],
    ['extensions', { extensions: [{ name: 'required-plugin' }] }],
    ['authority extensions', { relayflowV2Authority: { ...authority, extensions: [{ name: 'plugin' }] } }],
  ])('refuses %s before writes', async (_label, changes) => {
    const calls = cloud(replies({ ...parked, ...changes }));
    await expect(answerCloudFlow(RUN, true, options)).rejects.toMatchObject({ code: 'unsupported_source' });
    expect(calls.every(c => c.method === 'GET')).toBe(true);
  });

  async function sourceWithSurface(version: string) {
    const dir = await mkdtemp(join(tmpdir(), 'cloud-answer-')); dirs.push(dir);
    const pkg = join(dir, 'node_modules', '@relayflows', 'surface'); await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@relayflows/surface', version,
      exports: { './runtime': './runtime.js' } }));
    // Importing this would throw; the resume path must only hash it.
    const runtime = 'throw new Error("surface runtime must not be imported");\n';
    await writeFile(join(pkg, 'runtime.js'), runtime);
    const source = join(dir, 'original.flow.ts'); await writeFile(source, workflow);
    return { source, surface: { packageName: '@relayflows/surface', version, packageSha256: await packageTreeSha256(pkg),
      runtimeSha256: createHash('sha256').update(runtime).digest('hex') } };
  }
  // Production records store only { version } for the Surface (see cloud-read tests).
  const versionOnly = { ...parked, relayflowV2Authority: { ...authority, source: { sha256: sourceSha256, surface: { version: '2.0.18' } } } };

  it('re-derives a version-only stored Surface from --source without importing it', async () => {
    const local = await sourceWithSurface('2.0.18');
    const calls = cloud(replies(versionOnly));
    await answerCloudFlow(RUN, true, { ...options, source: local.source });
    expect((calls[4]!.body as Record<string, unknown>).authoredAuthority).toEqual({ ...submitted, surface: local.surface });
  });

  it('refuses a version-only stored Surface without --source, or with a different local version, before writes', async () => {
    let calls = cloud(replies(versionOnly));
    await expect(answerCloudFlow(RUN, true, options)).rejects.toMatchObject({ code: 'unsupported_source' });
    expect(calls.every(c => c.method === 'GET')).toBe(true);
    vi.restoreAllMocks();
    const local = await sourceWithSurface('2.0.19');
    calls = cloud(replies(versionOnly));
    await expect(answerCloudFlow(RUN, true, { ...options, source: local.source }))
      .rejects.toMatchObject({ code: 'unsupported_source', message: expect.stringContaining('2.0.19') });
    expect(calls.every(c => c.method === 'GET')).toBe(true);
  });

  it('reads --source as bytes to recover a truncated stored copy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cloud-answer-')); dirs.push(dir);
    const source = join(dir, 'original.flow.ts'); await writeFile(source, workflow);
    const calls = cloud(replies({ ...parked, workflow: 'prefix' }));
    await answerCloudFlow(RUN, false, { ...options, source });
    expect(calls[4]!.body).toMatchObject({ workflow });
  });

  it('refuses a changed local source before answering', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cloud-answer-')); dirs.push(dir);
    const source = join(dir, 'changed.flow.ts'); await writeFile(source, 'changed');
    const calls = cloud(replies());
    await expect(answerCloudFlow(RUN, true, { ...options, source })).rejects.toThrow('--source');
    expect(calls).toHaveLength(2);
  });

  it.each([{}, { runId: 'different-run', humanWait: wait }, { openWaits: [wait, { ...wait, waitId: 'human-3' }] },
    { humanWait: { waitId: 'approval' } }, { humanWait: { ...wait, waitId: 'human-3' } },
    { humanWait: wait, openWaits: [wait] }, { answer: { waitId: 'human-2', answer: 'yes' } }])('refuses absent, ambiguous or inconsistent waits: %j', async body => {
    const calls = cloud([{ body: parked }, { body }]);
    await expect(answerCloudFlow(RUN, true, options)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(calls.every(c => c.method === 'GET')).toBe(true);
  });

  it('skips the resume POST when Cloud already resumed', async () => {
    const sequence = replies(); sequence[3] = { body: { ...parked, status: 'running', result: null } };
    const calls = cloud(sequence);
    expect(await answerCloudFlow(RUN, true, options)).toMatchObject({ resumedByCloud: true });
    expect(calls).toHaveLength(4);
  });

  it('retries from an identical recorded answer without answering twice', async () => {
    const calls = cloud([{ body: parked }, { body: { humanWait: null, answer: { waitId: 'human-2', answer: true } } },
      { body: parked }, { body: { runId: 'resumed-1', status: 'pending' } }]);
    await answerCloudFlow(RUN, true, options);
    expect(calls.filter(c => c.method === 'POST').map(c => c.path)).toEqual(['/api/v1/workflows/run']);
  });

  it('discovers a humanWait beside a null openWaits', async () => {
    const sequence = replies(); sequence[1] = { body: { humanWait: wait, openWaits: null } };
    const calls = cloud(sequence);
    expect(await answerCloudFlow(RUN, true, options)).toMatchObject({ waitId: 'human-2', runId: 'resumed-1' });
    expect(calls).toHaveLength(5);
  });

  it('retries with --note when the recorded answer omits its optional note', async () => {
    const calls = cloud([{ body: parked }, { body: { humanWait: null, answer: { waitId: 'human-2', answer: true } } },
      { body: parked }, { body: { runId: 'resumed-1', status: 'pending' } }]);
    await answerCloudFlow(RUN, true, { ...options, note: 'reviewed' });
    expect(calls.filter(c => c.method === 'POST').map(c => c.path)).toEqual(['/api/v1/workflows/run']);
  });

  it('refuses a recorded note that differs from --note without writes', async () => {
    const calls = cloud([{ body: parked }, { body: { answer: { waitId: 'human-2', answer: true, note: 'other' } } }]);
    await expect(answerCloudFlow(RUN, true, { ...options, note: 'reviewed' })).rejects.toThrow('recorded answer differs');
    expect(calls).toHaveLength(2);
  });

  it('refuses a conflicting recorded answer without writes', async () => {
    const calls = cloud([{ body: parked }, { body: { answer: { waitId: 'human-2', answer: false } } }]);
    await expect(answerCloudFlow(RUN, true, options)).rejects.toThrow('recorded answer differs');
    expect(calls).toHaveLength(2);
  });

  it('reports partial success and never retries a failed resume POST', async () => {
    const sequence = replies(); sequence[4] = { status: 503, body: {} };
    const calls = cloud(sequence);
    await expect(answerCloudFlow(RUN, true, options)).rejects.toMatchObject({
      answerRecorded: true, message: expect.stringContaining('resume could not be confirmed'),
    } satisfies Partial<CloudAnswerError>);
    expect(calls).toHaveLength(5);
  });

  it.each([false, true])('CLI answers and resumes (json=%s)', async json => {
    env(); cloud(replies()); const out = capture();
    expect(await runCli(['answer', '--cloud', RUN, 'yes', ...(json ? ['--json'] : [])], out.io)).toBe(0);
    if (json) expect(JSON.parse(out.stdout[0]!)).toMatchObject({ ok: true, runId: 'resumed-1', resumedFrom: RUN });
    else expect(out.stdout).toEqual([`ANSWERED ${RUN} human-2 yes`, 'RESUMED resumed-1']);
  });

  it('does not resume after an answer refusal in a successful HTTP response', async () => {
    const sequence = replies(); sequence[2] = { body: { ok: false, error: 'not accepted' } };
    const calls = cloud(sequence);
    await expect(answerCloudFlow(RUN, true, options)).rejects.toMatchObject({ answerRecorded: false });
    expect(calls).toHaveLength(3);
  });

  it.each([{}, { ok: null }, { ok: 'true' }, { status: 'recorded' }])('does not resume after an unconfirmed answer acknowledgement %j', async ack => {
    const sequence = replies(); sequence[2] = { body: ack };
    const calls = cloud(sequence);
    await expect(answerCloudFlow(RUN, true, options)).rejects.toMatchObject({ answerRecorded: false });
    expect(calls).toHaveLength(3);
    expect(calls.filter(c => c.path === '/api/v1/workflows/run')).toEqual([]);
  });

  it('CLI exposes answerRecorded when resume fails', async () => {
    env(); const sequence = replies(); sequence[4] = { status: 500, body: {} }; cloud(sequence);
    const out = capture();
    expect(await runCli(['answer', '--cloud', RUN, 'yes', '--json'], out.io)).toBe(1);
    expect(JSON.parse(out.stdout[0]!)).toMatchObject({ ok: false, answerRecorded: true, next: `flows answer --cloud ${RUN} yes` });
  });
});
