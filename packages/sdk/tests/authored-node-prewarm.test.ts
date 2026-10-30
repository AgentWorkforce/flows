import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The CLI starts the Node probe and executable hash while it loads the flow.
// The candidate here is a stand-in that answers the probe (optionally slowly,
// wrongly or verbosely) and records each invocation.
let directory: string, probes: string, previousOverride: string | undefined;
// The prewarm hashes on a worker thread so the flow load keeps the main thread.
const workers = vi.hoisted(() => ({ constructed: 0 }));
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  class CountedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) { super(...args); workers.constructed += 1; }
  }
  return { ...actual, Worker: CountedWorker };
});
type Authority = typeof import('../src/authored-node-authority.js');
let authority: Authority;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'authored-node-prewarm-'));
  probes = join(directory, 'probes');
  previousOverride = process.env['FLOWS_AUTHORED_NODE'];
});

beforeEach(async () => {
  writeFileSync(probes, '');
  workers.constructed = 0;
  // The prewarm and its memo are per process; give every case a fresh module.
  vi.resetModules();
  authority = await import('../src/authored-node-authority.js');
});

afterEach(() => {
  if (previousOverride === undefined) delete process.env['FLOWS_AUTHORED_NODE'];
  else process.env['FLOWS_AUTHORED_NODE'] = previousOverride;
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

const probeLog = (): string[] => readFileSync(probes, 'utf8').split('\n').filter(Boolean);

function candidate(name: string, { delaySeconds = 0, exit = 0, padding = 0, stderrBytes = 0 } = {}): string {
  const path = join(directory, name);
  const answer = JSON.stringify({ path, version: '22.14.0' }) + ' '.repeat(padding);
  writeFileSync(path, `#!/bin/sh\necho ${name} >> ${JSON.stringify(probes)}\nsleep ${delaySeconds}\n`
    + (stderrBytes > 0 ? `head -c ${stderrBytes} /dev/zero | tr '\\0' x >&2\n` : '')
    + `printf '%s' '${answer}'\nexit ${exit}\n`);
  chmodSync(path, 0o755);
  process.env['FLOWS_AUTHORED_NODE'] = path;
  return path;
}

describe('authored Node authority prewarm', () => {
  it('probes and hashes once; the later call reuses the same authority', async () => {
    const path = candidate('node-a');
    authority.prewarmNodeAuthority();
    const resolved = await authority.awaitNodeAuthority();
    expect(probeLog()).toEqual(['node-a']);
    expect(resolved).toEqual({
      path: realpathSync(path), version: '22.14.0',
      executableSha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    });
    expect(authority.nodeAuthority()).toBe(resolved);
    expect(probeLog()).toEqual(['node-a']);
    expect(workers.constructed).toBe(1);
  });

  it('returns at once and leaves the event loop free while the probe runs', async () => {
    candidate('node-slow', { delaySeconds: 0.4 });
    const started = performance.now();
    authority.prewarmNodeAuthority();
    expect(performance.now() - started).toBeLessThan(150);
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 20);
    try { await authority.awaitNodeAuthority(); } finally { clearInterval(ticker); }
    expect(ticks).toBeGreaterThan(5);
    expect(probeLog()).toEqual(['node-slow']);
  });

  it('probes again when a different candidate is selected by the time it is needed', async () => {
    candidate('node-before');
    authority.prewarmNodeAuthority();
    const after = candidate('node-after');
    expect((await authority.awaitNodeAuthority()).path).toBe(realpathSync(after));
    expect(probeLog()).toEqual(['node-before', 'node-after']);
  });

  it('leaves a failed probe to the call, which probes again and refuses', async () => {
    candidate('node-broken', { exit: 2 });
    authority.prewarmNodeAuthority();
    await expect(authority.awaitNodeAuthority()).rejects.toThrow('requires the embedded Node runner');
    expect(probeLog()).toEqual(['node-broken', 'node-broken']);
  });

  it('does not trust a probe answer over the output limit the synchronous probe enforces', async () => {
    candidate('node-verbose', { padding: 5000 });
    authority.prewarmNodeAuthority();
    await expect(authority.awaitNodeAuthority()).rejects.toThrow('requires the embedded Node runner');
    expect(probeLog()).toEqual(['node-verbose', 'node-verbose']);
  });

  it('does not trust a probe whose stderr is over the limit the synchronous probe enforces', async () => {
    candidate('node-noisy', { stderrBytes: 5000 });
    authority.prewarmNodeAuthority();
    await expect(authority.awaitNodeAuthority()).rejects.toThrow('requires the embedded Node runner');
    expect(probeLog()).toEqual(['node-noisy', 'node-noisy']);
  });

  it('stops a slow probe at once when the run no longer needs it', async () => {
    candidate('node-stuck', { delaySeconds: 5 });
    authority.prewarmNodeAuthority();
    while (probeLog().length === 0) await new Promise(resolve => setTimeout(resolve, 10));
    const started = performance.now();
    await authority.stopNodeAuthorityPrewarm();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(probeLog()).toEqual(['node-stuck']);
  });
});
