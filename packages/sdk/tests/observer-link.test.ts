import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizeObserverLine, runCli, type CliIo } from '../src/cli.js';
import {
  mintObserverUrl,
  readObserverLinkEnv,
  type ObserverFetch,
} from '../src/observer-link.js';
import { sendOk, sendResult, startLoopback, type LoopbackHandlers } from './journal-client-loopback.js';

const TESTDATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'testdata');
const HELLO_DETERMINISTIC = join(TESTDATA, 'hello-deterministic.flow.yaml');
const TEST_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-5',
  'deterministic-test-stub',
  'test-model-v1',
];

const temporaryDirectories: string[] = [];
const loopbackServers: Server[] = [];

afterEach(async () => {
  for (const server of loopbackServers.splice(0)) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  // Any test that reached into the module-global `fetch` (through
  // `runCli`) must clear the stub so a later test cannot inherit it.
  vi.unstubAllGlobals();
});

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    stdout,
    stderr,
  };
}

function temporaryProject(prefix = 'flows-observer-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, 'flows.json'), JSON.stringify({ executors: [], models: TEST_MODELS }));
  return directory;
}

async function startCliLoopback(dataDir: string, handlers: LoopbackHandlers): Promise<void> {
  const server = startLoopback(join(dataDir, 'relayflowd.sock'), handlers);
  loopbackServers.push(server);
  if (!server.listening) await once(server, 'listening');
}

/**
 * Build a `Response`-shaped stub. Kept minimal so we depend only on the
 * subset of `fetch`'s contract the observer module actually reads —
 * `.ok`, `.status`, and `.json()`.
 */
function jsonResponse(status: number, body: unknown): Awaited<ReturnType<ObserverFetch>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('mintObserverUrl', () => {
  it('mints an observer token and returns an /observer?key=<ot_live_...> URL', async () => {
    const fetch = vi.fn<ObserverFetch>().mockResolvedValue(
      jsonResponse(200, { data: { token: 'ot_live_abc123', id: 'ot_id_1' } }),
    );

    const result = await mintObserverUrl({
      workspaceKey: 'rk_live_key',
      fetch,
      uuid: () => 'fixed-uuid',
      now: () => 1_700_000_000_000,
    });

    expect(result).toEqual({ observerUrl: 'https://agentrelay.com/observer?key=ot_live_abc123' });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://agentrelay.com/v1/observer-tokens');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer rk_live_key');
    const payload = JSON.parse(init.body) as { name: string; scopes: string[]; expires_at: string };
    expect(payload.name).toBe('flows-run-fixed-uuid');
    expect(payload.scopes).toContain('stream:read');
    expect(payload.expires_at).toBe(new Date(1_700_000_000_000 + 86_400_000).toISOString());
  });

  it('respects a custom RELAYCAST_API_URL as both the mint host and the observer host', async () => {
    const fetch = vi.fn<ObserverFetch>().mockResolvedValue(
      jsonResponse(200, { data: { token: 'ot_live_zzz' } }),
    );

    const result = await mintObserverUrl({
      workspaceKey: 'rk_live_key',
      baseUrl: 'https://relay.example.com',
      fetch,
    });

    expect(result.observerUrl).toBe('https://relay.example.com/observer?key=ot_live_zzz');
    expect(fetch.mock.calls[0]![0]).toBe('https://relay.example.com/v1/observer-tokens');
  });

  it('returns a warning and no URL when the mint API returns 500', async () => {
    const fetch = vi.fn<ObserverFetch>().mockResolvedValue(jsonResponse(500, { error: 'boom' }));

    const result = await mintObserverUrl({ workspaceKey: 'rk_live_key', fetch });

    expect(result.observerUrl).toBeUndefined();
    expect(result.warning).toBe('mint API returned HTTP 500');
  });

  it('returns a warning when the response is missing a valid ot_live_ token', async () => {
    const fetch = vi.fn<ObserverFetch>().mockResolvedValue(
      jsonResponse(200, { data: { token: 'rk_live_wrong_kind' } }),
    );

    const result = await mintObserverUrl({ workspaceKey: 'rk_live_key', fetch });

    expect(result.observerUrl).toBeUndefined();
    expect(result.warning).toBe('mint API response missing ot_live_ token');
  });

  it('returns a warning on a network error, never throws', async () => {
    const fetch = vi.fn<ObserverFetch>().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await mintObserverUrl({ workspaceKey: 'rk_live_key', fetch });

    expect(result.observerUrl).toBeUndefined();
    expect(result.warning).toBe('network error: ECONNREFUSED');
  });

  it('returns a warning when the configured base URL is not a valid URL', async () => {
    const fetch = vi.fn<ObserverFetch>();

    const result = await mintObserverUrl({
      workspaceKey: 'rk_live_key',
      baseUrl: 'not a url',
      fetch,
    });

    expect(result.observerUrl).toBeUndefined();
    expect(result.warning).toContain('invalid RELAYCAST_API_URL');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('readObserverLinkEnv', () => {
  it('reads RELAYCAST_WORKSPACE_KEY, trimming whitespace', () => {
    const env = readObserverLinkEnv({ RELAYCAST_WORKSPACE_KEY: '  rk_live_x  ' });
    expect(env.workspaceKey).toBe('rk_live_x');
    expect(env.suppressed).toBe(false);
  });

  it('treats an empty key as absent, not present', () => {
    expect(readObserverLinkEnv({ RELAYCAST_WORKSPACE_KEY: '   ' }).workspaceKey).toBeUndefined();
    expect(readObserverLinkEnv({}).workspaceKey).toBeUndefined();
  });

  it('reads FLOWS_NO_OBSERVER=1 as suppressed; any other value stays live', () => {
    expect(readObserverLinkEnv({ FLOWS_NO_OBSERVER: '1' }).suppressed).toBe(true);
    expect(readObserverLinkEnv({ FLOWS_NO_OBSERVER: '0' }).suppressed).toBe(false);
    expect(readObserverLinkEnv({ FLOWS_NO_OBSERVER: 'true' }).suppressed).toBe(false);
    expect(readObserverLinkEnv({}).suppressed).toBe(false);
  });

  it('picks up RELAYCAST_API_URL when non-empty', () => {
    expect(readObserverLinkEnv({ RELAYCAST_API_URL: 'https://relay.example.com' }).baseUrl)
      .toBe('https://relay.example.com');
    expect(readObserverLinkEnv({ RELAYCAST_API_URL: '' }).baseUrl).toBeUndefined();
  });
});

describe('finalizeObserverLine', () => {
  it('prints Observer: <url> on stdout when the mint resolves within the grace budget', async () => {
    const output = capture();
    const mint = Promise.resolve({ observerUrl: 'https://agentrelay.com/observer?key=ot_live_x' });
    await finalizeObserverLine(mint, output.io, 100);
    expect(output.stdout).toEqual(['Observer: https://agentrelay.com/observer?key=ot_live_x']);
    expect(output.stderr).toEqual([]);
  });

  it('prints the mint-failed diagnostic on stderr when the mint resolved with a warning', async () => {
    const output = capture();
    const mint = Promise.resolve({ warning: 'mint API returned HTTP 500' });
    await finalizeObserverLine(mint, output.io, 100);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([
      '[observer] token mint failed: mint API returned HTTP 500; skipping observer link',
    ]);
  });

  it('prints the timeout stderr line and stops waiting when the mint never resolves', async () => {
    const output = capture();
    // A promise that never resolves stands in for a stalled Relaycast call.
    // If `finalizeObserverLine` were unbounded the awaited call would hang
    // forever; the assertion after it proves the grace budget was honored.
    const hung = new Promise<{ observerUrl?: string; warning?: string }>(() => {});
    await finalizeObserverLine(hung, output.io, 20);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([
      '[observer] mint did not complete in time; skipping observer link',
    ]);
  });

  it('emits nothing at all when the mint was skipped (undefined input)', async () => {
    const output = capture();
    await finalizeObserverLine(undefined, output.io, 100);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toEqual([]);
  });
});

/**
 * End-to-end through `runCli`: use the same journal-client loopback the CLI
 * suite uses for the daemon, and stub the global `fetch` for the mint call.
 * These tests exist to catch integration-level regressions in the plumbing —
 * flag parsing, mint scheduling, emit ordering — that pure module tests miss.
 */
describe('flows run: observer link integration', () => {
  const RUN_ARGS = (dataDir: string): string[] => [
    'run', '--data-dir', dataDir, HELLO_DETERMINISTIC,
  ];

  it('prints the Observer: line immediately after RUN when a workspace key is set', async () => {
    const dataDir = temporaryProject();
    await startCliLoopback(dataDir, {
      hello: sendOk,
      'run.start': (ctx) => sendResult(ctx, {
        run_id: 'run-observer-happy',
        status: 'completed',
        completion_reason: 'success',
        completed_steps: 2,
      }),
    });
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { token: 'ot_live_integration_ok' } }),
    });
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('RELAYCAST_WORKSPACE_KEY', 'rk_live_operator');
    vi.stubEnv('FLOWS_NO_OBSERVER', '');

    const output = capture();
    const exit = await runCli(RUN_ARGS(dataDir), output.io);

    expect(exit).toBe(0);
    const runIndex = output.stdout.findIndex((line) => line.startsWith('RUN run-observer-happy'));
    expect(runIndex).toBeGreaterThanOrEqual(0);
    expect(output.stdout[runIndex + 1]).toBe(
      'Observer: https://agentrelay.com/observer?key=ot_live_integration_ok',
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('emits no observer line and no fetch when no workspace key is set', async () => {
    const dataDir = temporaryProject();
    await startCliLoopback(dataDir, {
      hello: sendOk,
      'run.start': (ctx) => sendResult(ctx, {
        run_id: 'run-observer-silent',
        status: 'completed',
        completion_reason: 'success',
        completed_steps: 2,
      }),
    });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('RELAYCAST_WORKSPACE_KEY', '');
    vi.stubEnv('FLOWS_NO_OBSERVER', '');

    const output = capture();
    const exit = await runCli(RUN_ARGS(dataDir), output.io);

    expect(exit).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(output.stdout.some((line) => line.startsWith('Observer:'))).toBe(false);
    expect(output.stderr.some((line) => line.includes('[observer]'))).toBe(false);
  });

  it('warns on stderr and proceeds normally when the mint API 500s', async () => {
    const dataDir = temporaryProject();
    await startCliLoopback(dataDir, {
      hello: sendOk,
      'run.start': (ctx) => sendResult(ctx, {
        run_id: 'run-observer-mint-500',
        status: 'completed',
        completion_reason: 'success',
        completed_steps: 2,
      }),
    });
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    });
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('RELAYCAST_WORKSPACE_KEY', 'rk_live_operator');
    vi.stubEnv('FLOWS_NO_OBSERVER', '');

    const output = capture();
    const exit = await runCli(RUN_ARGS(dataDir), output.io);

    expect(exit).toBe(0);
    expect(output.stdout.some((line) => line.startsWith('RUN run-observer-mint-500'))).toBe(true);
    expect(output.stdout.some((line) => line.startsWith('Observer:'))).toBe(false);
    expect(output.stderr.some(
      (line) => line.includes('[observer] token mint failed: mint API returned HTTP 500'),
    )).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('suppresses the mint entirely when --no-observer-link is passed', async () => {
    const dataDir = temporaryProject();
    await startCliLoopback(dataDir, {
      hello: sendOk,
      'run.start': (ctx) => sendResult(ctx, {
        run_id: 'run-observer-flag-off',
        status: 'completed',
        completion_reason: 'success',
        completed_steps: 2,
      }),
    });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('RELAYCAST_WORKSPACE_KEY', 'rk_live_operator');

    const output = capture();
    const exit = await runCli(
      ['run', '--no-observer-link', '--data-dir', dataDir, HELLO_DETERMINISTIC],
      output.io,
    );

    expect(exit).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(output.stdout.some((line) => line.startsWith('Observer:'))).toBe(false);
  });

  it('suppresses the mint entirely when FLOWS_NO_OBSERVER=1 is set', async () => {
    const dataDir = temporaryProject();
    await startCliLoopback(dataDir, {
      hello: sendOk,
      'run.start': (ctx) => sendResult(ctx, {
        run_id: 'run-observer-env-off',
        status: 'completed',
        completion_reason: 'success',
        completed_steps: 2,
      }),
    });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('RELAYCAST_WORKSPACE_KEY', 'rk_live_operator');
    vi.stubEnv('FLOWS_NO_OBSERVER', '1');

    const output = capture();
    const exit = await runCli(RUN_ARGS(dataDir), output.io);

    expect(exit).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(output.stdout.some((line) => line.startsWith('Observer:'))).toBe(false);
  });

  it('emits RUN before the mint resolves and appends Observer on a later line', async () => {
    const dataDir = temporaryProject();
    await startCliLoopback(dataDir, {
      hello: sendOk,
      'run.start': (ctx) => sendResult(ctx, {
        run_id: 'run-observer-late-mint',
        status: 'completed',
        completion_reason: 'success',
        completed_steps: 2,
      }),
    });
    // Hold the mint response until we release it. This proves the RUN line
    // does not wait on the mint: without the fix from Task 1 the CLI would
    // block on `observerUrlFrom` before `emitRunReport` and the RUN line
    // would never appear on stdout inside our resolve window.
    let releaseMint: (value: { ok: true; status: 200; json: () => Promise<unknown> }) => void = () => {};
    const mintPromise = new Promise<{ ok: true; status: 200; json: () => Promise<unknown> }>((resolve) => {
      releaseMint = resolve;
    });
    const fetch = vi.fn().mockReturnValue(mintPromise);
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('RELAYCAST_WORKSPACE_KEY', 'rk_live_operator');
    vi.stubEnv('FLOWS_NO_OBSERVER', '');

    const output = capture();
    // Poll stdout while `runCli` is in flight: as soon as RUN appears, release
    // the mint. If Task 1 regressed and the RUN line waits on the mint, this
    // polling loop would time out because the mint would never be released.
    const cliDone = runCli(RUN_ARGS(dataDir), output.io);
    const runLandedBeforeMint = await new Promise<boolean>((resolve) => {
      const start = Date.now();
      const tick = (): void => {
        if (output.stdout.some((line) => line.startsWith('RUN run-observer-late-mint'))) {
          releaseMint({ ok: true, status: 200, json: async () => ({ data: { token: 'ot_live_late' } }) });
          resolve(true);
          return;
        }
        if (Date.now() - start > 3_000) { resolve(false); return; }
        setTimeout(tick, 10);
      };
      tick();
    });
    const exit = await cliDone;

    expect(runLandedBeforeMint).toBe(true);
    expect(exit).toBe(0);
    const runIndex = output.stdout.findIndex((line) => line.startsWith('RUN run-observer-late-mint'));
    const observerIndex = output.stdout.findIndex((line) => line.startsWith('Observer:'));
    expect(observerIndex).toBeGreaterThan(runIndex);
    expect(output.stdout[observerIndex]).toBe(
      'Observer: https://agentrelay.com/observer?key=ot_live_late',
    );
  });

  it('folds observerUrl into the --json payload rather than printing a bare line', async () => {
    const dataDir = temporaryProject();
    await startCliLoopback(dataDir, {
      hello: sendOk,
      'run.start': (ctx) => sendResult(ctx, {
        run_id: 'run-observer-json',
        status: 'completed',
        completion_reason: 'success',
        completed_steps: 2,
      }),
    });
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { token: 'ot_live_json' } }),
    });
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('RELAYCAST_WORKSPACE_KEY', 'rk_live_operator');
    vi.stubEnv('FLOWS_NO_OBSERVER', '');

    const output = capture();
    const exit = await runCli(
      ['run', '--json', '--data-dir', dataDir, HELLO_DETERMINISTIC],
      output.io,
    );

    expect(exit).toBe(0);
    // In --json mode the plain-text Observer line must not appear; the URL
    // rides in the JSON payload instead so structured consumers see one
    // authoritative signal, not two competing ones.
    expect(output.stdout.some((line) => line.startsWith('Observer:'))).toBe(false);
    const jsonLine = output.stdout.find((line) => line.startsWith('{'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!) as { runId: string; observerUrl?: string };
    expect(parsed.runId).toBe('run-observer-json');
    expect(parsed.observerUrl).toBe('https://agentrelay.com/observer?key=ot_live_json');
  });
});
