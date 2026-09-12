import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { startWebhookServer } from '../src/cli/serve-webhook.js';
import { TokenBucketLimiter, keyFor } from '../src/webhook-rate-limit.js';
import { verifySignature, schemeFor } from '../src/webhook-signature.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(done => {
    server.close(() => done()); server.closeAllConnections();
  });
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function temporary(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'flows-webhook-hardening-'));
  dirs.push(dir); return dir;
}
async function receiverWith(dir: string, env: NodeJS.ProcessEnv = {}, rateLimit = { ratePerSecond: 20, burst: 60 }): Promise<string> {
  const server = await startWebhookServer(dir, 0, { env, rateLimit });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  return `http://127.0.0.1:${address.port}`;
}

describe('webhook receiver hardening (#304)', () => {
  it('refuses github signatures that do not match the configured secret', async () => {
    const dir = await temporary();
    const base = await receiverWith(dir, { WEBHOOK_SECRET_GITHUB: 'topsecret' });
    const body = JSON.stringify({ type: 'pull_request', payload: { action: 'opened', number: 1 } });
    const wrong = 'sha256=' + createHmac('sha256', 'notmysecret').update(body).digest('hex');
    const response = await fetch(`${base}/providers/github`, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': wrong },
    });
    expect(response.status).toBe(401);
    const parsed = await response.json() as { error: string; reason: string };
    expect(parsed).toMatchObject({ error: 'webhook_signature_invalid' });
    expect(['missing', 'mismatch', 'malformed']).toContain(parsed.reason);
  });

  it('accepts a correctly-signed github payload when the secret is configured', async () => {
    const dir = await temporary();
    const secret = 'shared-secret';
    const base = await receiverWith(dir, { WEBHOOK_SECRET_GITHUB: secret });
    const body = JSON.stringify({ type: 'pull_request', payload: { action: 'opened', number: 2 } });
    const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    const response = await fetch(`${base}/providers/github`, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    });
    expect(response.status).toBe(202);
  });

  it('refuses when the signature header is missing but a secret is configured', async () => {
    const dir = await temporary();
    const base = await receiverWith(dir, { WEBHOOK_SECRET_GITHUB: 'topsecret' });
    const body = JSON.stringify({ type: 'pull_request', payload: { action: 'opened', number: 3 } });
    const response = await fetch(`${base}/providers/github`, {
      method: 'POST', body, headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(401);
    const parsed = await response.json() as { error: string; reason: string };
    expect(parsed).toEqual({ error: 'webhook_signature_invalid', reason: 'missing' });
  });

  it('runs unsigned when no secret is configured (loopback development mode)', async () => {
    const dir = await temporary();
    const base = await receiverWith(dir, {});
    const body = JSON.stringify({ type: 'pull_request', payload: { action: 'opened', number: 4 } });
    const response = await fetch(`${base}/providers/github`, {
      method: 'POST', body, headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(202);
  });

  it('rate-limits when burst is exhausted and returns Retry-After', async () => {
    const dir = await temporary();
    const base = await receiverWith(dir, {}, { ratePerSecond: 0, burst: 2 });
    const body = JSON.stringify({ type: 'pull_request', payload: { action: 'opened', number: 5 } });
    const post = () => fetch(`${base}/providers/github`, {
      method: 'POST', body, headers: { 'content-type': 'application/json' },
    });
    expect((await post()).status).toBe(202);
    expect((await post()).status).toBe(202);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect(await limited.json()).toMatchObject({ error: 'webhook_rate_limited' });
  });

  it('refuses provider payloads that do not match the declared shape', async () => {
    const dir = await temporary();
    const base = await receiverWith(dir, {});
    const bad = JSON.stringify({ type: 'not_a_real_event', payload: {} });
    const response = await fetch(`${base}/providers/github`, {
      method: 'POST', body: bad, headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'webhook_payload_invalid' });
  });
});

describe('webhook-signature helpers', () => {
  it('rejects a missing supplied header as `missing`', () => {
    expect(verifySignature('github', Buffer.from('x'), undefined, 'secret')).toEqual({ ok: false, reason: 'missing' });
    expect(verifySignature('github', Buffer.from('x'), '', 'secret')).toEqual({ ok: false, reason: 'missing' });
  });
  it('rejects malformed headers as `malformed`', () => {
    expect(verifySignature('github', Buffer.from('x'), 'sha256=zz', 'secret')).toMatchObject({ ok: false });
  });
  it('accepts a correctly-signed payload', () => {
    const body = Buffer.from('hello');
    const scheme = schemeFor('github');
    const good = scheme.compute(body, 'secret');
    expect(verifySignature('github', body, good, 'secret')).toEqual({ ok: true });
  });
});

describe('token-bucket rate limiter', () => {
  it('allows up to burst then refuses; refills over time', () => {
    let now = 1_000_000;
    const limiter = new TokenBucketLimiter({ ratePerSecond: 1, burst: 3 }, () => now);
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.consume('k').allowed).toBe(true);
    }
    expect(limiter.consume('k')).toEqual({ allowed: false, retryAfterMs: 1000 });
    now += 2000;
    expect(limiter.consume('k').allowed).toBe(true);
    expect(limiter.consume('k').allowed).toBe(true);
  });

  it('keys independently per (provider, name, source)', () => {
    const limiter = new TokenBucketLimiter({ ratePerSecond: 0, burst: 1 });
    expect(limiter.consume(keyFor('github', 'pr', '10.0.0.1')).allowed).toBe(true);
    expect(limiter.consume(keyFor('github', 'pr', '10.0.0.1')).allowed).toBe(false);
    expect(limiter.consume(keyFor('github', 'pr', '10.0.0.2')).allowed).toBe(true);
  });
});
