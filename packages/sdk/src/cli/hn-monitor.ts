/**
 * `flows hn-monitor start` — CLI-inlined proactive workload for gate 2.
 *
 * runHnMonitor is a public function (not a class) that composes the
 * primitives directly: connect journal → hello → attach agent worker →
 * loop pollHackerNewsOnce → drain on abort → close.
 *
 * Poll errors classify into two shapes only:
 *   - `instanceof HnTransientFetchError` → log and continue next tick.
 *   - anything else → non-transient (journal failure OR programmer
 *     error); log with the actual class name and terminate (fail-closed
 *     per covenant 2).
 */

import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pollHackerNewsOnce, HnTransientFetchError, type Fetcher } from '../hn-poller.js';
import { AgentWorker } from '../worker.js';
import { JournalClient } from '../journal-client.js';
import type { EventSubmitResult, HelloResult, Pins } from '../protocol.js';
import type { CliIo } from '../cli.js';

const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * Minimum client surface runHnMonitor uses. Concrete return types come
 * from `protocol.ts`, not `unknown`, so a future rename or shape change
 * in the journal protocol fails to compile here rather than drifting
 * silently past the interface.
 */
export interface HnMonitorClient {
  hello(client: string): Promise<HelloResult>;
  eventSubmit(spec: unknown, event: { type: string; payload?: unknown; key?: string }): Promise<EventSubmitResult>;
  close(): void;
}

/** Minimum worker surface runHnMonitor uses (matches AgentWorker). */
export interface HnMonitorWorker {
  close(): Promise<void> | void;
}

/**
 * Base fields every caller — production and tests — supplies.
 */
interface HnMonitorArgsBase {
  /** Data directory containing relayflowd.sock. Required. */
  dataDir: string;
  /** Absolute path to the canonical flow spec JSON. Required. */
  specPath: string;
  /** How often to fetch top-stories. Default 60000ms. */
  pollIntervalMs?: number;
  /**
   * Cap on iterations. Undefined = unbounded (production). Any value
   * ≥ 0 caps; 0 means "attach, run zero polls, drain, exit 0" — used
   * by tests that only need to prove the setup/teardown paths.
   */
  maxPolls?: number;
  /** AbortSignal for external cancellation (tests / SIGINT wiring). */
  signal?: AbortSignal;
}

/**
 * Injection surface for tests. connectClient AND attachWorker MUST be
 * supplied together — the fallback attach path relies on the client
 * being a real JournalClient, which only the default connect path can
 * guarantee. Enforcing the pairing at the type level catches the
 * "override connect, forget attach" foot-gun the M lens flagged at
 * compile time. Fetcher is orthogonal — it plumbs through to
 * `pollHackerNewsOnce`, not the transport.
 */
interface HnMonitorInjections {
  connectClient: (socketPath: string) => Promise<HnMonitorClient>;
  attachWorker: (client: HnMonitorClient, onWorkerError: (err: unknown) => void) => Promise<HnMonitorWorker>;
  fetcher?: Fetcher;
}

/**
 * Production shape — no injections; runHnMonitor builds a real
 * JournalClient and a real AgentWorker.
 */
interface HnMonitorProduction {
  connectClient?: never;
  attachWorker?: never;
  fetcher?: Fetcher;
}

/** Args parsed by cli.ts and handed to runHnMonitor. */
export type HnMonitorArgs = HnMonitorArgsBase & (HnMonitorProduction | HnMonitorInjections);

/**
 * Return a COPY of the spec in which each step's relative `cli` is an
 * absolute path anchored at the spec file's directory. The input is not
 * modified — a caller that still needs the declared relative path (for
 * logging, re-serialization, or handing the spec to another tool) keeps it.
 *
 * `flows check` resolves a declared CLI against the spec's directory
 * (sdk/src/cli/check.ts `probeCli`), but AgentWorker ultimately calls
 * `spawn(cli, ...)`, which resolves a relative path against the WORKER
 * PROCESS's cwd. Those two are the same only when the runner happens to
 * be started from the spec's directory. Without this, a spec that
 * `flows check` passes still dies with ENOENT once launched from
 * anywhere else — preflight-green but unrunnable, the worst shape for a
 * gate that is supposed to prove the workload runs.
 *
 * Bare command names (no separator) are left alone: those are PATH
 * lookups, and both probeCli and spawn already agree on them.
 */
export function resolveSpecCliPaths<T>(spec: T, specPath: string): T {
  if (typeof spec !== 'object' || spec === null) return spec;
  const steps = (spec as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return spec;
  const base = dirname(resolve(specPath));
  const resolved = steps.map((step) => {
    if (typeof step !== 'object' || step === null) return step;
    const cli = (step as { cli?: unknown }).cli;
    if (typeof cli !== 'string' || isAbsolute(cli)) return step;
    // Both separators: on Windows a relative `preflight\analyzer` contains no
    // '/', so a '/'-only test would misread it as a bare PATH command and
    // leave it unresolved.
    if (!cli.includes('/') && !cli.includes('\\')) return step;
    return { ...step, cli: resolve(base, cli) };
  });
  return { ...spec, steps: resolved };
}

/** Interruptible sleep — wakes on abort as well as timeout. */
function sleepInterruptible(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function defaultConnectClient(socketPath: string): Promise<HnMonitorClient> {
  const client = new JournalClient(socketPath);
  await client.connect();
  await client.hello('hn-monitor');
  return client;
}

async function defaultAttachWorker(
  client: JournalClient,
  onWorkerError: (err: unknown) => void,
): Promise<HnMonitorWorker> {
  const pins: Pins = {
    workspace: [{ surface: 'repo', revision_id: 'live' }],
    streams: [],
  };
  // workerId encodes pid so a same-machine restart shows up as a fresh
  // worker; a container restart that recycles pids before the prior
  // lease expires will collide until `workerRelease` is implemented
  // (documented in worker.ts and tracked as gate-2 follow-up work).
  const worker = new AgentWorker(client, {
    workerId: `hn-monitor-${process.pid}`,
    pins,
  });
  // AgentWorker extends EventEmitter and emits 'error' when a dispatched
  // step's execute() throws. Without a listener, Node re-throws
  // synchronously, bypasses the drain-aware close(), and crashes the
  // process. Subscribe BEFORE attach so an error during attach is not
  // lost.
  worker.on('error', onWorkerError);
  await worker.attach();
  return worker;
}

/**
 * Run the hn-monitor CLI subcommand. Returns 0 on clean shutdown (signal
 * or maxPolls), 1 on any fail-closed condition (spec unreadable, connect
 * failure, hello failure, worker attach failure, journal failure during
 * poll).
 */
export async function runHnMonitor(args: HnMonitorArgs, io: CliIo): Promise<0 | 1> {
  const pollIntervalMs = args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const socketPath = `${args.dataDir}/relayflowd.sock`;

  let spec: unknown;
  try {
    spec = resolveSpecCliPaths(JSON.parse(await readFile(args.specPath, 'utf8')), args.specPath);
  } catch (err) {
    io.stderr(`hn-monitor: cannot read spec at ${args.specPath}: ${String(err)}`);
    return 1;
  }

  // The discriminated union on HnMonitorArgs guarantees connectClient
  // and attachWorker come as a pair OR neither is set. When neither is
  // set, we take the fully-typed default path; when both are set,
  // callers supply their own consistent fake pair. The prior "override
  // one, forget the other" foot-gun no longer typechecks.
  const usingInjections = args.connectClient !== undefined;
  const connect: (socketPath: string) => Promise<HnMonitorClient> =
    usingInjections ? args.connectClient! : defaultConnectClient;
  const attach: (c: HnMonitorClient, onErr: (err: unknown) => void) => Promise<HnMonitorWorker> =
    usingInjections
      ? args.attachWorker!
      : (c, onErr) => defaultAttachWorker(c as JournalClient, onErr);

  let client: HnMonitorClient;
  try {
    client = await connect(socketPath);
  } catch (err) {
    io.stderr(`hn-monitor: cannot connect to relayflowd at ${socketPath}: ${String(err)}`);
    return 1;
  }

  // Async event surface: AgentWorker emits 'error' from step-dispatch
  // callbacks that reject. Bubble those up as a fail-closed termination
  // reason via a shared cell so the main loop notices on its next tick.
  let workerErrorEvent: unknown;
  const onWorkerError = (err: unknown): void => {
    if (workerErrorEvent !== undefined) return;
    workerErrorEvent = err;
  };

  let worker: HnMonitorWorker;
  try {
    worker = await attach(client, onWorkerError);
  } catch (err) {
    io.stderr(`hn-monitor: worker attach failed: ${String(err)}`);
    client.close();
    return 1;
  }

  io.stdout(`hn-monitor: attached worker at ${socketPath}, poll every ${pollIntervalMs}ms`);

  let iterations = 0;
  let exit: 0 | 1 = 0;
  try {
    while (!(args.signal?.aborted ?? false)) {
      // Cap check FIRST — maxPolls === 0 must exit before dispatching
      // any poll; the prior placement ran one poll before checking,
      // making the "0 = skip" semantics undocumented and surprising.
      if (args.maxPolls !== undefined && iterations >= args.maxPolls) break;
      // Worker's async error surface preempts the next poll — an emitted
      // 'error' from a prior tick's dispatch means the worker's contract
      // is broken and the loop must terminate.
      if (workerErrorEvent !== undefined) {
        io.stderr(`hn-monitor: worker emitted error, terminating: ${nameAndMessage(workerErrorEvent)}`);
        exit = 1;
        break;
      }
      let terminate = false;
      try {
        await pollHackerNewsOnce(spec, {
          eventSubmit: (specArg, event) => client.eventSubmit(specArg, event),
        }, args.fetcher ? { fetcher: args.fetcher } : {});
      } catch (err) {
        if (err instanceof HnTransientFetchError) {
          io.stderr(`hn-monitor: poll fetch failed (continuing next tick): ${String(err)}`);
        } else {
          // Non-transient: journal failure OR programmer bug in the
          // poller. Log the actual class name so a real bug is not
          // silently attributed to the journal.
          io.stderr(`hn-monitor: non-transient error, terminating: ${nameAndMessage(err)}`);
          exit = 1;
          terminate = true;
        }
      }
      if (terminate) break;
      iterations++;
      if (args.signal?.aborted) break;
      await sleepInterruptible(pollIntervalMs, args.signal);
    }
  } finally {
    // Drain in-flight step executions before closing the socket. Worker's
    // close() awaits Promise.allSettled on its own in-flight tracker.
    await worker.close();
    client.close();
  }
  io.stdout(`hn-monitor: shutdown after ${iterations} iteration(s)`);
  return exit;
}

function nameAndMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
