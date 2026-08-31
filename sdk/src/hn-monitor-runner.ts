/**
 * Continuous Hacker News polling runner — composes the existing pieces into
 * the real workload gate 2 wants to see. Third attempt (Track A v2), scoped
 * bigger than the previous two:
 *
 *   - the runner itself (this file)
 *   - `AgentWorker.close()` is now async + drain-aware (see sdk/src/worker.ts)
 *   - the flow spec is pinned by an in-memory content-addressed digest
 *     computed once at startup (see SpecBundle below) so runtime changes to
 *     the spec file cannot skew events across polls
 *   - a real e2e integration test (sdk/tests/hn-monitor-e2e.test.ts) proves
 *     poll -> journal -> kernel wake -> dispatch -> stepComplete against a
 *     live relayflowd
 *
 * Ladder:
 *   sdk/src/hn-poller.ts    -> fetches HN, submits events over the journal
 *   sdk/src/worker.ts       -> attaches for agent steps, runs their declared
 *                              cli, drains in-flight steps on close
 *   sdk/src/journal-client  -> wire protocol
 *
 * Non-goals for THIS PR (documented so history lens doesn't reject):
 *   - CLI wrapper (`flows hn-monitor start`) — sub-PR C.
 *   - ops/STATE.md + docs/RFC-0001 gate-2 GREEN declaration — sub-PR D.
 */

import { readFile } from 'node:fs/promises';
import { pollHackerNewsOnce, type EventSink, type Fetcher } from './hn-poller.js';
import { AgentWorker, type AgentWorkerOptions } from './worker.js';
import { JournalClient, JournalProtocolError } from './journal-client.js';
import { specHash } from './canonical.js';

/**
 * Frozen, content-addressed snapshot of a flow spec. Constructed by the
 * runner ONCE at startup so runtime mutation of the on-disk spec file cannot
 * skew events across polls (RFC-0001 settled decision #14 — bundle digests
 * as the immutable reference).
 *
 * This is the smallest-viable indirection — a full bundle-digest / relayfile
 * bundle system is a broader refactor. The runner treats `SpecBundle.spec`
 * as opaque data and hands it to eventSubmit; `SpecBundle.digest` is
 * carried so consumers (logs, tests) can attest to the exact bytes.
 */
export interface SpecBundle {
  spec: unknown;
  digest: string;
}

/**
 * Duck-typed minimum surface the runner needs from a journal client. Lets
 * tests inject a fake without constructing a real socket-backed client.
 */
export interface RunnerJournalClient {
  connect?(): Promise<void>;
  hello?(client: string): Promise<unknown>;
  eventSubmit(spec: unknown, event: { type: string; payload?: unknown; key?: string }): Promise<unknown>;
  close?(): void;
}

/**
 * Duck-typed minimum surface for the agent worker. Same reason. `close()`
 * is optional-async — the runner awaits it if it returns a promise.
 */
export interface RunnerAgentWorker {
  attach?(): Promise<void>;
  close?(): void | Promise<void>;
}

export interface HnMonitorRunnerOptions {
  /**
   * Spec source. Provide EITHER `spec` (already-parsed, immutable) OR
   * `specPath` (filesystem path — the runner reads it ONCE at startup and
   * hashes it to build a SpecBundle). Callers with control over spec
   * production should prefer `spec:` — that path never touches the fs.
   */
  spec?: unknown;
  specPath?: string;
  /** Unix socket path where relayflowd is listening. */
  socketPath: string;
  /** How long to sleep between polls. Default 60000 ms. */
  pollIntervalMs?: number;
  /** Identity used when constructing the AgentWorker. */
  worker: AgentWorkerOptions;
  /**
   * External abort signal. When it fires the runner drains the current tick,
   * closes the worker + client, and returns cleanly. Preferred over
   * process-level signal handlers (which this module deliberately does not
   * register — CLI wrappers wire process signals to an AbortController).
   */
  signal?: AbortSignal;
  /** Injection for tests / non-default fetchers. */
  fetcher?: Fetcher;
  /**
   * Inject a pre-built journal client. The runner skips its own connect()/
   * hello() bootstrap (assumes already connected), but STILL calls close()
   * at shutdown — close() is idempotent-safe on both JournalClient and
   * simple test doubles.
   */
  client?: RunnerJournalClient;
  /**
   * Inject a pre-built agent worker. The runner calls attach() and close()
   * on it just as it would on an internally-constructed worker. A real
   * AgentWorker throws on double-attach, so callers must not inject an
   * already-attached instance; tests use non-attaching doubles.
   */
  workerInstance?: RunnerAgentWorker;
  /**
   * Called when a poll throws a FETCH-level error (HN API 5xx, network
   * flakiness, malformed body). Default logs to console.error. Journal
   * errors are a different class and always propagate.
   */
  onFetchError?: (err: unknown) => void;
  /** Story limit forwarded to pollHackerNewsOnce. */
  storyLimit?: number;
  /**
   * Hard cap on iterations — for tests that don't want to rely on abort
   * timing. Undefined means unbounded (production).
   */
  maxPolls?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * A JOURNAL error propagates out of run() and terminates the runner. We
 * detect the two shapes JournalClient actually throws:
 *
 *   - `JournalProtocolError` — thrown for server-side rejection frames
 *   - plain `Error` with a `journal client:` message prefix — thrown for
 *     transport failures (connect, socket close, framing, not-connected)
 *
 * A prior message-regex heuristic missed `JournalProtocolError` (whose
 * message is `<code>: <message>`), silently forwarding real kernel
 * rejections to onFetchError. `instanceof` catches the class directly.
 */
function looksLikeJournalError(err: unknown): boolean {
  if (err instanceof JournalProtocolError) return true;
  if (err instanceof Error && /^journal client:/.test(err.message)) return true;
  return false;
}

/**
 * Build a SpecBundle from an in-memory spec object. Digest is sha256 of
 * the CANONICAL encoding (sorted keys) so two logically-identical specs
 * produce the same digest regardless of construction/insertion order.
 *
 * Uses `specHash` from sdk/src/canonical.ts (also used by the compiler)
 * so bundle-digest attestation matches spec-hash attestation elsewhere
 * in the codebase.
 */
export function bundleSpec(spec: unknown): SpecBundle {
  return { spec, digest: specHash(spec) };
}

/**
 * Build a SpecBundle by reading a file ONCE. Delegates to bundleSpec on
 * the parsed value so the digest is a function of the SPEC (canonical
 * encoding), never the raw file bytes — two spec files that differ only
 * in whitespace produce the same digest, which is what "content-addressed
 * reference" means.
 */
export async function bundleSpecFromPath(path: string): Promise<SpecBundle> {
  const raw = await readFile(path, 'utf8');
  const spec: unknown = JSON.parse(raw);
  return bundleSpec(spec);
}

export class HnMonitorRunner {
  private readonly bundleSource: () => Promise<SpecBundle>;
  private readonly socketPath: string;
  private readonly pollIntervalMs: number;
  private readonly workerOptions: AgentWorkerOptions;
  private readonly signal: AbortSignal | undefined;
  private readonly fetcher: Fetcher | undefined;
  private readonly injectedClient: RunnerJournalClient | undefined;
  private readonly injectedWorker: RunnerAgentWorker | undefined;
  private readonly onFetchError: (err: unknown) => void;
  private readonly storyLimit: number | undefined;
  private readonly maxPolls: number | undefined;

  private stopping = false;
  private client: RunnerJournalClient | undefined;
  private worker: RunnerAgentWorker | undefined;
  private bundle: SpecBundle | undefined;

  constructor(options: HnMonitorRunnerOptions) {
    if ((options.spec === undefined) === (options.specPath === undefined)) {
      throw new Error(
        'HnMonitorRunner: provide exactly one of `spec` or `specPath` — ' +
        'they are mutually exclusive ways to supply the flow spec bundle.',
      );
    }
    // Symmetric guard: both sides must be provided together, or neither.
    // A workerInstance without a client would leave the injected worker
    // pointing at the runner's fresh JournalClient — an implicit test-
    // double contract that's easy to break silently.
    if ((options.client === undefined) !== (options.workerInstance === undefined)) {
      throw new Error(
        'HnMonitorRunner: `client` and `workerInstance` must be injected together — ' +
        'RunnerJournalClient does not carry the surface AgentWorker uses, so a mismatched ' +
        'pair (one injected, one internal) launders a type mismatch or leaves the injected ' +
        'worker wired to a client the caller never sees.',
      );
    }
    if (options.spec !== undefined) {
      const spec = options.spec;
      this.bundleSource = () => Promise.resolve(bundleSpec(spec));
    } else {
      const path = options.specPath!;
      this.bundleSource = () => bundleSpecFromPath(path);
    }
    this.socketPath = options.socketPath;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.workerOptions = options.worker;
    this.signal = options.signal;
    this.fetcher = options.fetcher;
    this.injectedClient = options.client;
    this.injectedWorker = options.workerInstance;
    this.onFetchError = options.onFetchError ?? ((err) => {
      // Fetch errors are transient by design; journal errors never reach here.
      // eslint-disable-next-line no-console
      console.error('hn-monitor: poll fetch failed:', err);
    });
    this.storyLimit = options.storyLimit;
    this.maxPolls = options.maxPolls;
  }

  /**
   * The frozen spec bundle the runner is submitting under. Undefined until
   * run() has completed its startup phase. Exposed for tests that want to
   * attest the runner is stable across polls.
   */
  get specBundle(): SpecBundle | undefined { return this.bundle; }

  /**
   * Enter the polling loop. The worker attaches BEFORE the first poll —
   * a run parked because no worker attached is only revived by run.resume,
   * which live-kernel.test.ts pins as a contract.
   *
   * Resolves cleanly on abort or maxPolls. Rejects on spec/attach failure
   * or any JOURNAL error surfaced by eventSubmit (fail-closed).
   */
  async run(): Promise<void> {
    this.bundle = await this.bundleSource();

    this.client = this.injectedClient ?? new JournalClient(this.socketPath);
    if (!this.injectedClient && typeof this.client.connect === 'function') {
      await this.client.connect();
    }
    if (!this.injectedClient && typeof this.client.hello === 'function') {
      await this.client.hello('hn-monitor');
    }

    this.worker = this.injectedWorker
      ?? new AgentWorker(this.client as unknown as JournalClient, this.workerOptions);
    if (typeof this.worker.attach === 'function') {
      await this.worker.attach();
    }

    const abortListener = (): void => { this.stopping = true; };
    this.signal?.addEventListener('abort', abortListener, { once: true });

    const sink: EventSink = {
      eventSubmit: (specArg, event) => this.client!.eventSubmit(specArg, event),
    };

    let polls = 0;
    try {
      while (!this.stopping && !(this.signal?.aborted ?? false)) {
        try {
          // Submit under the frozen bundle spec — never re-read from disk.
          await pollHackerNewsOnce(this.bundle.spec, sink, {
            fetcher: this.fetcher,
            storyLimit: this.storyLimit,
          });
        } catch (err) {
          if (looksLikeJournalError(err)) throw err;
          this.onFetchError(err);
        }
        polls++;
        if (this.maxPolls !== undefined && polls >= this.maxPolls) break;
        if (this.stopping || (this.signal?.aborted ?? false)) break;
        await this.sleepInterruptible(this.pollIntervalMs);
      }
    } finally {
      this.signal?.removeEventListener('abort', abortListener);
      await this.close();
    }
  }

  /**
   * Idempotent shutdown. Awaits the worker's async close (which drains
   * in-flight step executions per its own contract) and then closes the
   * journal socket. Resets internal flags so run() can be called again on
   * the same instance after a graceful shutdown.
   */
  async close(): Promise<void> {
    if (this.worker && typeof this.worker.close === 'function') {
      // AgentWorker.close() is async and drains; test doubles may return
      // synchronously — await either way.
      await this.worker.close();
    }
    if (this.client && typeof this.client.close === 'function') {
      this.client.close();
    }
    this.worker = undefined;
    this.client = undefined;
    // Reset stopping so a subsequent run() actually enters its loop.
    // Without this a second run() would exit immediately if the first
    // was aborted (silent no-op — the exact "test that wouldn't fail if
    // the behavior broke" smell).
    this.stopping = false;
  }

  /**
   * Sleep that wakes on abort signal as well as timeout.
   *
   * Timer branch removes the abort listener explicitly (so it doesn't
   * accumulate on the caller's shared AbortSignal across polls). Abort
   * branch relies on `{ once: true }` for cleanup — semantic equivalent,
   * different mechanism.
   */
  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.signal;
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
}
