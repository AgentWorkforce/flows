import { spawn } from 'node:child_process';
import { FORCE_KILL_DELAY_MS, childStop, ownsProcessGroup } from './child-stop.js';
import {
  WRAPPER_EXECUTE_TOKEN,
  WRAPPER_IDENTIFY_ARG,
  WRAPPER_IDENTIFY_TOKEN,
} from './cli-adapter.js';
import {
  captureWrapperIdentity,
  sameWrapperIdentity,
  type WrapperIdentity,
} from './wrapper-runtime.js';

export interface WrapperSessionLimits {
  handshakeTimeoutMs: number;
  /**
   * How long the wrapper may work after acknowledging the request, or `0` for
   * no deadline at all — the same convention `CliInvocation.timeoutMs` already
   * uses for a native CLI spawn, where `worker-cli.ts` arms its timer only
   * `if (invocation.timeoutMs > 0)`. `0` is the default, so a wrapper-backed
   * step is bounded by the lease abort exactly as a `claude` or `codex` step
   * is, and not by a constant neither of those pays.
   */
  executionTimeoutMs: number;
  maxOutputBytes: number;
}

export interface WrapperSessionResult {
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
}

const DEFAULT_LIMITS: WrapperSessionLimits = {
  handshakeTimeoutMs: 10_000,
  executionTimeoutMs: 0,
  maxOutputBytes: 1_048_576,
};
const HANDSHAKE_OUTPUT_LIMIT = 8_192;
/**
 * Grace after `SIGKILL` before the reader settles on its own. Node emits
 * `'close'` only once every inherited stdio pipe is closed, which any
 * descendant of the wrapper can withhold forever. Resolution therefore may
 * not depend on `'close'`: past this point the reader settles regardless.
 */
const SETTLE_AFTER_KILL_MS = 250;
/**
 * How long a session with NO execution deadline waits, after the wrapper
 * process itself is gone, for its stdio to finish draining.
 *
 * The execution deadline used to be what settled a wrapper that exited while a
 * descendant still held an inherited pipe, because `'close'` waits on every
 * one of them. That job is real; keying it on elapsed time was not. It is
 * keyed on the wrapper's own exit instead, which is the fact that actually
 * matters. Reaching the end of this grace is not proof that a pipe was leaked
 * — buffered output may simply still be in flight — so the grace is a policy
 * and the stop that follows it is bounded, not a diagnosis.
 */
const DRAIN_AFTER_EXIT_MS = 250;

/**
 * Identify and execute a custom wrapper in one pinned process. No private
 * request is written until its declared path still names the captured file.
 */
export function runWrapperSession(
  cli: string,
  instruction: string,
  wakeContext: unknown,
  model: string | undefined,
  env: NodeJS.ProcessEnv,
  overrides: Partial<WrapperSessionLimits> = {},
  signal?: AbortSignal,
  /** Working directory for the wrapper process; the artifact scanner uses the same root. */
  cwd?: string,
): Promise<WrapperSessionResult> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (signal !== undefined && process.platform === 'win32') {
    return Promise.reject(new Error('Lease-bound wrapper execution requires macOS or Linux process-group cancellation; Windows is unsupported.'));
  }
  const limits = sessionLimits(overrides);
  let request: string;
  try {
    request = JSON.stringify({
      protocol: WRAPPER_IDENTIFY_TOKEN,
      instruction,
      ...(model !== undefined ? { model } : {}),
      ...(wakeContext !== undefined ? { wakeContext } : {}),
    });
  } catch (error) {
    return Promise.resolve(failure(
      `wake_context could not be JSON-serialized for the CLI: ${String(error)}`,
    ));
  }
  let identity: WrapperIdentity;
  try {
    identity = captureWrapperIdentity(cli, env);
  } catch (error) {
    return Promise.resolve(failure(
      `CLI ${JSON.stringify(cli)} wrapper identity could not be pinned: ${String(error)}`,
    ));
  }

  return executePinnedWrapper(cli, identity, request, env, limits, signal, cwd);
}

function executePinnedWrapper(
  cli: string,
  identity: WrapperIdentity,
  request: string,
  env: NodeJS.ProcessEnv,
  limits: WrapperSessionLimits,
  signal?: AbortSignal,
  cwd?: string,
): Promise<WrapperSessionResult> {
  return new Promise((resolve) => {
    const ownsGroup = ownsProcessGroup(signal);
    const child = spawn(identity.executable, [WRAPPER_IDENTIFY_ARG], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      detached: ownsGroup,
      ...(cwd === undefined ? {} : { cwd }),
    });
    const stop = childStop(child, ownsGroup);
    const stdout: string[] = [];
    const stderr: Buffer[] = [];
    let handshakePending = '';
    let executionPending = '';
    let capturedBytes = 0;
    let phase: 'identity' | 'ack' | 'execute' = 'identity';
    let protocolError: string | undefined;
    let settled = false;
    let outputFinalized = false;
    let childExited = false;
    let exitCode: number | null = null;
    /** The handshake deadline, then the execution deadline if there is one. */
    let lifecycleTimer: NodeJS.Timeout | undefined;
    /** `terminate`'s own settle deadline. */
    let settleTimer: NodeJS.Timeout | undefined;
    /** The post-exit drain grace, armed only when execution is unlimited. */
    let drainTimer: NodeJS.Timeout | undefined;
    /** The settle deadline the drain's own stop owes, after its escalation. */
    let drainSettleTimer: NodeJS.Timeout | undefined;
    // Each deadline owns its own handle. They can be armed at the same time —
    // a drain grace can be running when an over-limit final line terminates
    // the session — and a shared variable would drop the only reference to
    // one of them and leave it pending past the settle.

    const finish = (result: WrapperSessionResult): void => {
      if (settled) return;
      settled = true;
      if (lifecycleTimer !== undefined) clearTimeout(lifecycleTimer);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      if (drainSettleTimer !== undefined) clearTimeout(drainSettleTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    /**
     * INVARIANT: a session may not settle until either the process group is
     * confirmed dead or the escalation has actually run.
     *
     * `'close'` and `'error'` are evidence about the DIRECT CHILD and nothing
     * more. A descendant that ignores `SIGTERM` and inherited none of the
     * wrapper's stdio emits exactly those events while it is still running, so
     * neither may drop a pending escalation and neither may settle ahead of
     * one. Every child-level settle therefore goes through
     * `maySettleOnChildExit`, which is the one place that asks the GROUP.
     *
     * When it says no, `terminate`'s own deadline settles instead, with a
     * byte-identical `failure(protocolError)` result. That deadline is armed
     * whenever an escalation is — both come from the single `terminate` below —
     * so refusing here can defer a settle but can never strand one.
     */
    const finishOnChildExit = (result: WrapperSessionResult): void => {
      // Asked before `finish`, and asked even once we have already settled:
      // this is also the only place a pointless escalation is refunded, and a
      // session that settled on `terminate`'s deadline still owes that refund.
      if (!stop.maySettleOnChildExit()) return;
      finish(result);
    };
    const onAbort = (): void => {
      stop.kill();
      finish(failure('Agent execution aborted: lease ownership lost.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    const terminate = (message: string): void => {
      if (protocolError !== undefined) return;
      protocolError = message;
      if (lifecycleTimer !== undefined) clearTimeout(lifecycleTimer);
      lifecycleTimer = undefined;
      // A refusal wins over a drain that was going to report the wrapper's own
      // exit as a success: from here this settle belongs to the deadline armed
      // below, and a drain that still fired would stop the tree a second time.
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      drainTimer = undefined;
      // Same reach as an abort, only gentler first: this stop must find the
      // whole group, or a descendant outlives the session still holding the
      // stdio it inherited.
      stop.terminate();
      // The reader owns the bound. `'close'` is emitted only after every
      // inherited stdio pipe closes, so a wrapper that leaves a descendant
      // holding one withholds it forever and strands the step with no
      // `completionReason` at all. Settle on our own deadline instead — the
      // same shape `spawnInvocation` uses in worker-cli.ts, where the timer
      // resolves rather than delegating to a child-controlled event. The
      // result is byte-identical to the one the `'close'` path would build
      // for this `protocolError`, so this changes only WHEN we settle.
      settleTimer = setTimeout(
        () => finish(failure(message)),
        FORCE_KILL_DELAY_MS + SETTLE_AFTER_KILL_MS,
      );
    };
    const startExecutionTimer = (): void => {
      if (lifecycleTimer !== undefined) clearTimeout(lifecycleTimer);
      lifecycleTimer = undefined;
      // `0` is no deadline, exactly as `worker-cli.ts` reads
      // `invocation.timeoutMs` for a native CLI. The handshake deadline it
      // just replaced was a liveness check and is over; nothing else is armed,
      // and what bounds the work from here is the lease abort — the same thing
      // that bounds a `claude` or `codex` step.
      if (limits.executionTimeoutMs <= 0) return;
      lifecycleTimer = setTimeout(() => terminate(
        `CLI ${JSON.stringify(cli)} execution timed out after ${limits.executionTimeoutMs}ms.`,
      ), limits.executionTimeoutMs);
    };
    const exceedsOutputLimit = (additionalBytes: number): boolean => {
      const pendingBytes = Buffer.byteLength(executionPending);
      if (capturedBytes + pendingBytes + additionalBytes <= limits.maxOutputBytes) return false;
      terminate(
        `CLI ${JSON.stringify(cli)} exceeded the captured output limit of ${limits.maxOutputBytes} bytes.`,
      );
      return true;
    };
    const appendStdout = (value: string): void => {
      const bytes = Buffer.byteLength(value);
      capturedBytes += bytes;
      stdout.push(value);
    };
    const acceptHandshakeLine = (line: string): void => {
      const normalized = normalizeLine(line);
      if (phase === 'identity') {
        if (normalized !== WRAPPER_IDENTIFY_TOKEN) {
          terminate(`CLI ${JSON.stringify(cli)} did not identify as ${WRAPPER_IDENTIFY_TOKEN} at worker execution.`);
          return;
        }
        if (!sameWrapperIdentity(cli, env, identity)) {
          terminate(`CLI ${JSON.stringify(cli)} wrapper identity changed before private request delivery.`);
          return;
        }
        phase = 'ack';
        child.stdin.end(`${request}\n`);
        return;
      }
      if (phase === 'ack') {
        if (normalized !== WRAPPER_EXECUTE_TOKEN) {
          terminate(`CLI ${JSON.stringify(cli)} did not accept the ${WRAPPER_IDENTIFY_TOKEN} same-process execution request.`);
          return;
        }
        phase = 'execute';
        startExecutionTimer();
        // The wrapper may already be gone: `'exit'` is delivered as soon as the
        // process dies, while the bytes it wrote are still being read out of
        // the pipe. The exit is remembered rather than acted on, and the drain
        // grace starts here, once the acknowledgement it waits behind has
        // actually been consumed.
        startDrainGrace();
      }
    };
    const acceptExecutionData = (chunk: string): void => {
      executionPending += chunk;
      if (exceedsOutputLimit(0)) return;
      while (true) {
        const newline = executionPending.indexOf('\n');
        if (newline < 0) return;
        const line = executionPending.slice(0, newline);
        executionPending = executionPending.slice(newline + 1);
        if (normalizeLine(line) === WRAPPER_EXECUTE_TOKEN) {
          terminate(`CLI ${JSON.stringify(cli)} emitted a duplicate execute protocol frame.`);
          return;
        }
        appendStdout(`${line}\n`);
      }
    };
    const handshakeComplete = (): boolean => phase === 'execute';
    /**
     * Fold the last un-terminated line into the captured output, exactly once.
     *
     * Two settles can now reach this — `'close'` and the drain grace — and the
     * pending buffer may only be spent by one of them. A second finalization
     * that appended it again would duplicate the wrapper's own result, and a
     * buffer left in place would go on being counted against `maxOutputBytes`
     * by any later chunk.
     */
    const finalizeOutput = (): void => {
      if (outputFinalized) return;
      outputFinalized = true;
      if (protocolError === undefined && phase === 'execute' && executionPending.length > 0) {
        if (normalizeLine(executionPending) === WRAPPER_EXECUTE_TOKEN) {
          protocolError = `CLI ${JSON.stringify(cli)} emitted a duplicate execute protocol frame.`;
        } else if (!exceedsOutputLimit(0)) {
          appendStdout(executionPending);
        }
      }
      executionPending = '';
    };
    /**
     * The one result builder. A recorded protocol or output failure outranks
     * the exit status: a wrapper that violated the contract is refused even
     * when the process it ran in went on to exit 0.
     */
    const executionResult = (code: number | null): WrapperSessionResult => {
      finalizeOutput();
      if (protocolError !== undefined || phase !== 'execute') {
        return failure(
          protocolError
            ?? `CLI ${JSON.stringify(cli)} exited before completing the ${WRAPPER_IDENTIFY_TOKEN} same-process handshake.`,
        );
      }
      return {
        exit_code: code,
        stdout_tail: stdout.join(''),
        stderr_tail: Buffer.concat(stderr).toString('utf8'),
      };
    };
    const drainExpired = (): void => {
      drainTimer = undefined;
      if (settled) return;
      const result = executionResult(exitCode);
      // Finalizing can itself refuse the session — an over-limit final line —
      // and `terminate` has then already stopped the tree and armed its own
      // settle deadline. Stopping or arming a second time here would leave two
      // deadlines racing for one settle.
      if (settleTimer !== undefined) return;
      // The wrapper is gone and `'close'` has still not arrived, so something
      // it left behind is holding stdio it inherited. Stop what is reachable —
      // a settle that releases no pipes lets the step complete while
      // `flows run` never exits — and then own the settle regardless: the
      // force kill has no callback, and a descendant that escaped into its own
      // group before the wrapper died is not traceable to this spawn at all.
      stop.terminate();
      drainSettleTimer = setTimeout(
        () => finish(executionResult(exitCode)),
        FORCE_KILL_DELAY_MS + SETTLE_AFTER_KILL_MS,
      );
      // Settle now if the stop turned out to have nothing to reach; otherwise
      // the deadline above owns it, and a `'close'` that arrives once the
      // group is empty may still settle earlier.
      finishOnChildExit(result);
    };
    /**
     * Arm the post-exit drain, for an unlimited session that has both seen the
     * wrapper exit and consumed its acknowledgement. A session with an explicit
     * execution deadline keeps its existing behaviour: that deadline is what
     * bounds a withheld `'close'` there, and nothing about it changes.
     */
    const startDrainGrace = (): void => {
      if (limits.executionTimeoutMs > 0) return;
      if (!childExited || phase !== 'execute') return;
      if (settled || drainTimer !== undefined || protocolError !== undefined) return;
      drainTimer = setTimeout(drainExpired, DRAIN_AFTER_EXIT_MS);
    };

    lifecycleTimer = setTimeout(() => terminate(
      `CLI ${JSON.stringify(cli)} did not identify as ${WRAPPER_IDENTIFY_TOKEN} within ${limits.handshakeTimeoutMs}ms.`,
    ), limits.handshakeTimeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      // Once the output has been finalized the result is built and the
      // captured bytes are spent. A late chunk — the drain grace has expired
      // and a descendant still owns the pipe — may neither be appended to a
      // result already reported nor re-judged against a limit already applied.
      if (protocolError !== undefined || outputFinalized) return;
      if (phase === 'execute') {
        acceptExecutionData(chunk);
        return;
      }
      handshakePending += chunk;
      // Drain every complete line FIRST. The handshake bound belongs to the
      // handshake, and a line that is already terminated is no longer part
      // of it: the execute token sitting at the front of this buffer ends
      // the handshake, and the bytes behind it are execution output bound by
      // `maxOutputBytes`. Measuring the whole buffer before draining capped a
      // conforming wrapper's first result flush at HANDSHAKE_OUTPUT_LIMIT
      // whenever the OS coalesced its writes, and named the wrong bound.
      while (!handshakeComplete()) {
        const newline = handshakePending.indexOf('\n');
        if (newline < 0) break;
        const line = handshakePending.slice(0, newline);
        handshakePending = handshakePending.slice(newline + 1);
        acceptHandshakeLine(line);
        if (protocolError !== undefined) return;
      }
      if (handshakeComplete()) {
        if (handshakePending.length > 0) {
          const remainder = handshakePending;
          handshakePending = '';
          acceptExecutionData(remainder);
        }
        return;
      }
      // Still handshaking: bound the un-terminated residue, which is the only
      // buffer the handshake still owns.
      if (Buffer.byteLength(handshakePending) > HANDSHAKE_OUTPUT_LIMIT) {
        terminate(
          `CLI ${JSON.stringify(cli)} exceeded the wrapper handshake limit of ${HANDSHAKE_OUTPUT_LIMIT} bytes before completing the ${WRAPPER_IDENTIFY_TOKEN} handshake.`,
        );
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (protocolError !== undefined || outputFinalized || exceedsOutputLimit(chunk.byteLength)) return;
      capturedBytes += chunk.byteLength;
      stderr.push(chunk);
    });
    child.stdin.on('error', () => {
      // A child that closes stdin before acknowledgement is classified on close.
    });
    child.once('error', (error) => finishOnChildExit(failure(error.message)));
    // `'exit'` is evidence about the DIRECT CHILD only: the wrapper process is
    // gone, whether or not anything it spawned still holds the stdio it
    // inherited. That is exactly the fact the drain grace waits on, and it is
    // not evidence of a dead group — nothing here settles or stops.
    child.once('exit', (code) => {
      childExited = true;
      exitCode = code;
      startDrainGrace();
    });
    child.once('close', (code) => finishOnChildExit(executionResult(code)));
  });
}

function sessionLimits(overrides: Partial<WrapperSessionLimits>): WrapperSessionLimits {
  return {
    handshakeTimeoutMs: positiveLimit(overrides.handshakeTimeoutMs, DEFAULT_LIMITS.handshakeTimeoutMs),
    executionTimeoutMs: durationLimit(overrides.executionTimeoutMs, DEFAULT_LIMITS.executionTimeoutMs),
    maxOutputBytes: positiveLimit(overrides.maxOutputBytes, DEFAULT_LIMITS.maxOutputBytes),
  };
}

/** A bound a wrapper may not switch off: `0` and below fall back. */
function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * A duration that may be switched off, so `0` is a value and not a missing
 * one. Reusing {@link positiveLimit} here would coerce an explicit "no
 * deadline" back to the fallback, which is how the default became unreachable.
 */
function durationLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function normalizeLine(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function failure(stderr_tail: string): WrapperSessionResult {
  return { exit_code: null, stdout_tail: '', stderr_tail };
}
