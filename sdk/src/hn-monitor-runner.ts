/**
 * Continuous Hacker News polling runner — composes the existing pieces into
 * the real workload the drive loop is supposed to run.
 *
 * Ladder:
 *   sdk/src/hn-poller.ts    -> fetches HN, submits events over the journal
 *   sdk/src/worker.ts       -> attaches for agent steps, runs their declared cli
 *   sdk/src/journal-client  -> wire protocol
 *
 * This module composes them into a loop. Polling drives event submission;
 * event submission wakes runs (kernel wake, PR #14); wake dispatches an agent
 * step; the attached AgentWorker runs it. Nothing here re-implements retry,
 * scheduling, or dedupe — the kernel owns those.
 *
 * Design notes addressing swarm findings from the walked-away PR #83:
 *
 *   1. FAIL-CLOSED ON JOURNAL ERRORS. Only fetch-level errors are swallowed
 *      (HN API flakiness is transient by nature); an eventSubmit failure
 *      propagates out of run() and terminates the runner. That is the
 *      covenant-2 contract: a journal write that fails fails the step.
 *
 *   2. AgentWorker.close() drains local handlers but does NOT tell the
 *      kernel to release the worker registration — there is no `workerRelease`
 *      verb in sdk/src/protocol.ts yet. When it lands (kernel + protocol),
 *      plug it in here; this runner already routes shutdown through
 *      AgentWorker.close() so the change is local.
 *
 *   3. All class fields are declared at the top of the class body, before
 *      the constructor, so future default-initializer additions can't
 *      silently erase the constructor's assignments.
 *
 *   4. Signal handling is OPT-IN via `options.signal: AbortSignal`. This
 *      module registers no process-level SIGTERM/SIGINT handlers — a
 *      library user embedding it can cancel one runner without affecting
 *      others. The CLI wrapper (sub-PR C) wires process signals to an
 *      AbortController.
 *
 *   5. Tests cover: fetch throw → loop survives; journal throw → loop
 *      terminates. Without those, a future edit that turns onFetchError
 *      into a no-op or that catches journal errors would slip through.
 *
 * Scope for THIS PR: the runner assembles and its unit tests hold. Proving
 * the workload actually EXECUTES end-to-end (dispatch → step complete
 * against a real relayflowd) is deliberately sub-PR B (integration test).
 * A CLI wrapper is sub-PR C. Gate 2 GREEN declaration is sub-PR D.
 */

import { readFile } from 'node:fs/promises';
import { pollHackerNewsOnce, type EventSink, type Fetcher } from './hn-poller.js';
import { AgentWorker, type AgentWorkerOptions } from './worker.js';
import { JournalClient, JournalProtocolError } from './journal-client.js';

/**
 * Duck-typed minimum surface the runner needs from a journal client. Lets
 * tests inject a fake without having to construct a real socket-backed
 * JournalClient.
 */
export interface RunnerJournalClient {
  connect?(): Promise<void>;
  hello?(client: string): Promise<unknown>;
  eventSubmit(spec: unknown, event: { type: string; payload?: unknown; key?: string }): Promise<unknown>;
  close?(): void;
}

/**
 * Duck-typed minimum surface for the agent worker. Same reason.
 */
export interface RunnerAgentWorker {
  attach?(): Promise<void>;
  close?(): void;
}

export interface HnMonitorRunnerOptions {
  /** Absolute path to the canonicalized flow spec JSON. */
  specPath: string;
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
   * register — see design note 4).
   */
  signal?: AbortSignal;
  /** Injection for tests / non-default fetchers. */
  fetcher?: Fetcher;
  /**
   * Inject a pre-built journal client. The runner skips its own connect()/
   * hello() bootstrap when this is provided (assumes already connected),
   * but STILL calls close() at shutdown — close() is idempotent-safe on
   * both JournalClient and simple test doubles.
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
  /**
   * Story limit forwarded to pollHackerNewsOnce. Default is the poller's
   * DEFAULT_STORY_LIMIT (5).
   */
  storyLimit?: number;
  /**
   * Hard cap on iterations — for tests that don't want to rely on abort
   * timing. Undefined means unbounded (production).
   */
  maxPolls?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * Fail-closed classification: identify a JOURNAL error so it can propagate
 * out of run() and terminate the runner. Everything else is treated as a
 * transient FETCH failure and forwarded to onFetchError so the loop
 * continues.
 *
 * We check the shapes JournalClient can actually produce:
 *   - `JournalProtocolError` — thrown for server-side rejection frames
 *     (message format is `<code>: <message>`, e.g. `subscription_missing: ...`)
 *   - plain `Error` with a `journal client:` message prefix — thrown for
 *     transport failures (connect, socket close, framing, not-connected)
 *
 * A prior iteration relied on a message-regex heuristic that MISSED
 * `JournalProtocolError` entirely (its message doesn't start with
 * `journal client:`). That silently forwarded real kernel-side rejections
 * to onFetchError as fetch failures — the exact fail-open the swarm caught.
 * `instanceof` catches the class directly; string prefix catches the
 * transport-error class.
 */
function looksLikeJournalError(err: unknown): boolean {
  if (err instanceof JournalProtocolError) return true;
  if (err instanceof Error && /^journal client:/.test(err.message)) return true;
  return false;
}

export class HnMonitorRunner {
  // Fields declared at the top of the class body (design note 3).
  private readonly specPath: string;
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

  constructor(options: HnMonitorRunnerOptions) {
    // If a caller injects a duck-typed client, they MUST also inject the
    // worker — the RunnerJournalClient interface doesn't include the
    // workerAttach/stepComplete/on/off surface a real AgentWorker needs,
    // so constructing an AgentWorker over an injected client would launder
    // a type mismatch. Fail-closed on the invalid combo.
    if (options.client !== undefined && options.workerInstance === undefined) {
      throw new Error(
        'HnMonitorRunner: injecting `client` requires also injecting `workerInstance` — ' +
        'the duck-typed RunnerJournalClient does not carry the surface AgentWorker uses.',
      );
    }
    this.specPath = options.specPath;
    this.socketPath = options.socketPath;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.workerOptions = options.worker;
    this.signal = options.signal;
    this.fetcher = options.fetcher;
    this.injectedClient = options.client;
    this.injectedWorker = options.workerInstance;
    this.onFetchError = options.onFetchError ?? ((err) => {
      // Fetch errors are transient by design; log and let the next tick
      // recover. Journal errors NEVER reach here (see run()'s catch).
      // eslint-disable-next-line no-console
      console.error('hn-monitor: poll fetch failed:', err);
    });
    this.storyLimit = options.storyLimit;
    this.maxPolls = options.maxPolls;
  }

  /**
   * Enter the polling loop. The worker attaches BEFORE the first poll — a
   * run parked because no worker attached is only revived by run.resume,
   * which live-kernel.test.ts pins as a contract.
   *
   * Resolves cleanly on:
   *   - the abort signal firing
   *   - the maxPolls cap being reached (tests only)
   *
   * Rejects on:
   *   - initial spec read failure
   *   - worker.attach() failure
   *   - any JOURNAL error surfaced by eventSubmit (fail-closed)
   */
  async run(): Promise<void> {
    const spec: unknown = JSON.parse(await readFile(this.specPath, 'utf8'));

    this.client = this.injectedClient ?? new JournalClient(this.socketPath);
    // Only connect/hello a client the runner constructed itself; an injected
    // client is assumed already-connected (tests use recording doubles).
    if (!this.injectedClient && typeof this.client.connect === 'function') {
      await this.client.connect();
    }
    if (!this.injectedClient && typeof this.client.hello === 'function') {
      await this.client.hello('hn-monitor');
    }

    this.worker = this.injectedWorker
      ?? new AgentWorker(this.client as unknown as JournalClient, this.workerOptions);
    // Attach ALWAYS runs (whether the runner constructed the worker or the
    // caller injected one). Test doubles must survive attach + close being
    // called; a real AgentWorker throws on double-attach so callers must not
    // inject an already-attached instance.
    if (typeof this.worker.attach === 'function') {
      await this.worker.attach();
    }

    const abortListener = (): void => { this.stopping = true; };
    this.signal?.addEventListener('abort', abortListener, { once: true });

    const sink: EventSink = {
      // Any journal failure here propagates out of pollHackerNewsOnce and
      // out of run() — fail-closed per finding #1.
      eventSubmit: (specArg, event) => this.client!.eventSubmit(specArg, event),
    };

    let polls = 0;
    try {
      while (!this.stopping && !(this.signal?.aborted ?? false)) {
        try {
          await pollHackerNewsOnce(spec, sink, {
            fetcher: this.fetcher,
            storyLimit: this.storyLimit,
          });
        } catch (err) {
          // Journal errors terminate the runner (fail-closed). Everything
          // else — HN API failures, JSON parse failures on the top-stories
          // feed — is a transient fetch problem: log and continue.
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
   * Idempotent shutdown. Detaches the worker from local dispatch events and
   * closes the journal socket.
   *
   * INTENTIONAL GAP: this does NOT release the worker registration with the
   * kernel — `sdk/src/protocol.ts` has no `workerRelease` verb today. The
   * kernel keeps this workerId in its registry until its lease expires. When
   * workerRelease lands (kernel side + protocol.ts), plug it into
   * AgentWorker.close() and this method inherits the fix.
   */
  async close(): Promise<void> {
    // ALWAYS close both, whether the runner constructed them or the caller
    // injected them. AgentWorker.close() and JournalClient.close() are both
    // idempotent-safe. Injected test doubles must also survive close().
    if (this.worker && typeof this.worker.close === 'function') {
      this.worker.close();
    }
    if (this.client && typeof this.client.close === 'function') {
      this.client.close();
    }
    this.worker = undefined;
    this.client = undefined;
  }

  /**
   * Sleep that wakes on abort signal as well as timeout.
   *
   * Both branches remove the abort listener explicitly. `{ once: true }` on
   * addEventListener only auto-removes on the abort-fire path; the
   * timer-fires-first path would otherwise accumulate listeners on the
   * caller's shared AbortSignal and trigger MaxListenersExceededWarning
   * after ~10 polls.
   */
  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.signal;
      if (signal?.aborted) {
        resolve();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        // Timer fired first; remove the abort listener so it doesn't leak.
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
