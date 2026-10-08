import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { canonicalize, specHash } from '../src/canonical.js';
import { runCli } from '../src/cli.js';
import { runFlow } from '../src/cli/run.js';
import { socketPathFor } from '../src/daemon-connection.js';
import { startLoopback, sendOk } from './journal-client-loopback.js';

for (const kind of ['step', 'input']) {
  const cases = JSON.parse(readFileSync(new URL(`../../../testdata/canonical/${kind}-canonical-cases.json`, import.meta.url), 'utf8')) as Array<{ name: string; value: unknown; canonical: string; sha256: string }>;
  describe(`${kind} canonical corpus shared with Rust`, () => {
    for (const test of cases) it(test.name, () => {
      expect(canonicalize(test.value)).toBe(test.canonical);
      expect(specHash(test.value)).toBe(test.sha256);
      if (test.value !== null && typeof test.value === 'object' && !Array.isArray(test.value)) {
        const reversed = Object.fromEntries(Object.entries(test.value).reverse());
        expect(specHash(reversed)).toBe(test.sha256);
      }
    });
  });
}

it.each([
  ['run', '--reuse-from'], ['run', '--reuse-from', '--json', 'flow.json'],
  ['run', '--reuse-from', 'one', '--reuse-from', 'two', 'flow.json'],
  ['resume', '--reuse-from', 'one', 'two'], ['check', '--reuse-from', 'one', 'flow.json'],
  ['run', '--cloud', '--reuse-from', 'one', 'flow.json'],
  ['run', '--reuse-from', 'one', 'flow.ts'],
])('refuses invalid reuse invocation %j', async (...args) => {
  expect(await runCli(args, { stdout() {}, stderr() {} })).toBe(2);
});

it.each([
  ['reuse_spec_mismatch', 2], ['reuse_run_not_found', 2], ['reuse_journal_read_failed', 1],
] as const)('threads source run and maps %s to exit %s', async (code, exitCode) => {
  const dir = mkdtempSync(join(tmpdir(), 'reuse-cli-'));
  const server = startLoopback(socketPathFor(dir), {
    hello: ctx => sendOk(ctx),
    'run.start': (ctx, params) => {
      expect(params['reuse_from_run_id']).toBe('prior');
      ctx.send({ id: ctx.id, ok: false, error: { code, message: 'source problem' } });
    },
  });
  await once(server, 'listening');
  try {
    const result = await runFlow(fileURLToPath(new URL('../../../testdata/hello-deterministic.flow.yaml', import.meta.url)),
      dir, { reuseFromRunId: 'prior', daemon: { spawn: false } });
    expect(result.exitCode).toBe(exitCode);
    expect(result.report.diagnostics.at(-1)?.kind).toBe(code);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

it('cancels runFlow promptly while a classification read is delayed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-cancel-read-'));
  let reading!: () => void;
  const inRead = new Promise<void>(resolve => { reading = resolve; });
  const server = startLoopback(socketPathFor(dir), {
    hello: ctx => sendOk(ctx),
    'run.start': ctx => ctx.send({ id: ctx.id, ok: true, result: { run_id: 'r1', status: 'running', completion_reason: null, completed_steps: 0 } }),
    'run.get': () => reading(), // the daemon never answers under load
  });
  await once(server, 'listening');
  const controller = new AbortController();
  try {
    const running = runFlow(fileURLToPath(new URL('../../../testdata/hello-deterministic.flow.yaml', import.meta.url)),
      dir, { daemon: { spawn: false }, signal: controller.signal });
    await inRead;
    const begun = performance.now();
    controller.abort();
    const settled = await Promise.race([running.then(() => 'settled', () => 'settled'), new Promise(resolve => setTimeout(() => resolve('still reading'), 2_000))]);
    expect(settled).toBe('settled');
    expect(performance.now() - begun).toBeLessThan(2_000);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
