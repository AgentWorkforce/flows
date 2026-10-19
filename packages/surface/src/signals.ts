/**
 * Hosted completion signals: `@relayflows/surface/signals`.
 *
 * Hosted Cloud runs materialize only `@relayflows/surface` next to the flow
 * source, so this module must stay importable on its own: no imports beyond
 * Node built-ins, and Cloud is reached through the global `fetch`. It is the
 * single implementation of the held-GET signal wait; `@relayflows/sdk`'s
 * `waitForCloudSignal` delegates to {@link holdSignalWait}.
 *
 * Call {@link waitForSignal} from the authored flow body. The run-bound read
 * credential lives only in that process; `f.run` children and agents never
 * receive it.
 */
import { setTimeout as delay } from "node:timers/promises";

/** The longest hold Cloud's signal GET accepts, and the default. */
export const SIGNAL_MAX_WAIT_MS = 25_000;
/** Cloud's run ID for this hosted run (not the engine's `RELAYFLOW_RUN_ID`). */
export const HOSTED_RUN_ID_ENV = "RELAYFLOW_V2_CLOUD_RUN_ID";
/** The run-bound, GET-only `workflow:signals:read` bearer Cloud gives the authored process. */
export const HOSTED_SIGNAL_READ_TOKEN_ENV = "RELAYFLOW_V2_SIGNAL_READ_TOKEN";
/** The Cloud application base URL the Flows CLI uses. */
export const CLOUD_URL_ENV = "FLOWS_CLOUD_URL";
export const DEFAULT_CLOUD_URL = "https://agentrelay.com/cloud";

const SIGNAL_NAME = /^[A-Za-z0-9_-]{1,80}$/u;
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_TIMER_MS = 2_147_483_647;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const FAST_204_MS = 1_000;
const FAST_204_INITIAL_BACKOFF_MS = 250;
const FAST_204_MAX_BACKOFF_MS = 5_000;

export type SignalErrorCode =
  | "configuration"
  | "invalid_input"
  | "invalid_response"
  | "http_error"
  | "transport_error"
  | "transient_error";

/** Set only for `configuration`: which local setting is missing or wrong. */
export type SignalConfigurationReason =
  | "run_id_missing"
  | "auth_missing"
  | "url_invalid"
  | "timeout_invalid";

export class SignalError extends Error {
  reason?: SignalConfigurationReason;

  constructor(
    readonly code: SignalErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SignalError";
  }
}

export interface WaitForSignalOptions {
  /** Hold per request, 0–25000 ms. Defaults to 25000. */
  waitMs?: number;
  /** Cancels the wait; the caller's abort reason is rethrown unchanged. */
  signal?: AbortSignal;
  /** Defaults to `process.env.RELAYFLOW_V2_CLOUD_RUN_ID`. */
  runId?: string;
  /** Defaults to `process.env.FLOWS_CLOUD_URL`, then https://agentrelay.com/cloud. */
  apiUrl?: string;
  /** Defaults to `process.env.RELAYFLOW_V2_SIGNAL_READ_TOKEN`. */
  token?: string;
  /** Bounds each held request; must exceed `waitMs`. Defaults to 30000. */
  requestTimeoutMs?: number;
}

/** Builds the error a caller sees; lets the SDK keep throwing `CloudFlowError`. */
export type SignalErrorFactory = (
  code: Exclude<SignalErrorCode, "configuration">,
  message: string,
  status?: number,
) => Error;

/**
 * The seams `@relayflows/sdk` supplies to share this implementation. Not part
 * of the authored-flow surface; use {@link waitForSignal} in a flow.
 */
export interface SignalWaitHooks {
  /** Resolved before every held request so a rotated credential is picked up. */
  connection(): Promise<{ baseUrl: string; token: string }> | { baseUrl: string; token: string };
  error?: SignalErrorFactory;
  /** Abort-aware sleep used for the fast-204 backoff. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
}

const signalError: SignalErrorFactory = (code, message, status) =>
  new SignalError(code, message, status);

function configurationError(reason: SignalConfigurationReason, message: string): SignalError {
  const error = new SignalError("configuration", message);
  error.reason = reason;
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates both path segments, run ID first, before any request. */
export function signalPath(runId: unknown, name: unknown, error: SignalErrorFactory = signalError): string {
  // Defensive path-segment constraint; accepting a new server ID format needs a Surface change.
  if (typeof runId !== "string" || !RUN_ID.test(runId)) {
    throw error("invalid_response", "Cloud run ID must contain only letters, digits, underscores, or hyphens.");
  }
  if (typeof name !== "string" || !SIGNAL_NAME.test(name)) {
    throw error("invalid_input", "Signal name must contain only letters, digits, underscores, or hyphens (1–80 characters).");
  }
  return `/api/v1/workflows/runs/${runId}/signals/${name}`;
}

/** Same classification as the SDK's Cloud transport: retryable network faults are transient. */
function transportError(cause: unknown, error: SignalErrorFactory): Error {
  const inner = cause instanceof Error ? cause.cause : undefined;
  const code = isRecord(inner) ? inner.code : undefined;
  const transient = (cause instanceof Error && cause.name === "TimeoutError")
    || ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"].includes(String(code));
  return transient
    ? error("transient_error", "Cloud transport temporarily unavailable.")
    : error("transport_error", "Cloud transport failed; check TLS and the configured URL (redirects are refused).");
}

function normalizeCloudBaseUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || !/^\/[A-Za-z0-9/_-]*$/u.test(url.pathname)) return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return undefined;
  }
}

/**
 * The shared held-GET loop. A normally held 204 re-arms immediately; a fast
 * 204 (under one second) backs off 250 ms doubling to a 5 s cap, so a proxy or
 * broken server cannot turn the wait into a hot loop. The backoff resets after
 * a normally held 204.
 *
 * `@relayflows/sdk` calls this with its own connection resolver and error
 * class; authored flows should call {@link waitForSignal}.
 */
export async function holdSignalWait(
  runId: unknown,
  name: unknown,
  options: Pick<WaitForSignalOptions, "waitMs" | "signal" | "requestTimeoutMs">,
  hooks: SignalWaitHooks,
): Promise<unknown> {
  const error = hooks.error ?? signalError;
  const sleep = hooks.sleep ?? ((ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal }));
  const path = signalPath(runId, name, error);
  const waitMs = options.waitMs ?? SIGNAL_MAX_WAIT_MS;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > SIGNAL_MAX_WAIT_MS) {
    throw error("invalid_input", "Signal waitMs must be an integer from 0 to 25000.");
  }
  const requestTimeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestTimeout) || requestTimeout <= waitMs) {
    throw error("invalid_input", `Signal requestTimeoutMs must exceed ${waitMs / 1000} seconds.`);
  }
  let fast204BackoffMs = FAST_204_INITIAL_BACKOFF_MS;
  for (;;) {
    options.signal?.throwIfAborted();
    const { baseUrl, token } = await hooks.connection();
    const deadline = AbortSignal.timeout(requestTimeout);
    const requestStartedAt = performance.now();
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}?waitMs=${waitMs}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
        // A redirect must never carry the credential to a different origin.
        redirect: "error",
      });
    } catch (cause) {
      options.signal?.throwIfAborted();
      throw transportError(deadline.aborted ? deadline.reason : cause, error);
    }
    if (response.status === 204) {
      if (performance.now() - requestStartedAt < FAST_204_MS) {
        try {
          await sleep(fast204BackoffMs, options.signal);
        } catch (cause) {
          options.signal?.throwIfAborted();
          throw cause;
        }
        fast204BackoffMs = Math.min(fast204BackoffMs * 2, FAST_204_MAX_BACKOFF_MS);
      } else {
        fast204BackoffMs = FAST_204_INITIAL_BACKOFF_MS;
      }
      continue;
    }
    // Do not echo server response bodies: they may contain credentials or source.
    if (!response.ok) throw error("http_error", `Cloud signal wait failed with HTTP ${response.status}.`, response.status);
    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      options.signal?.throwIfAborted();
      if (!(cause instanceof SyntaxError)) throw transportError(deadline.aborted ? deadline.reason : cause, error);
      throw error("invalid_response", "Cloud returned an invalid signal.");
    }
    if (!isRecord(body) || !Object.hasOwn(body, "payload") || typeof body.acceptedAt !== "number") {
      throw error("invalid_response", "Cloud returned an invalid signal.");
    }
    return body.payload;
  }
}

function hostedConnection(options: WaitForSignalOptions): { baseUrl: string; token: string } {
  const requestTimeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (requestTimeout > MAX_TIMER_MS) {
    throw configurationError("timeout_invalid", "requestTimeoutMs must be a positive 32-bit integer.");
  }
  const rawToken = options.token ?? process.env[HOSTED_SIGNAL_READ_TOKEN_ENV];
  const token = rawToken?.trim();
  if (!token || /[\r\n]/u.test(rawToken!) || /^(?:rk|ot)_live_/u.test(token)) {
    throw configurationError("auth_missing",
      `waitForSignal needs a Cloud signal-read token: pass { token }, or call it from a hosted run's authored body, where ${HOSTED_SIGNAL_READ_TOKEN_ENV} is set.`);
  }
  const raw = options.apiUrl ?? process.env[CLOUD_URL_ENV] ?? DEFAULT_CLOUD_URL;
  const baseUrl = normalizeCloudBaseUrl(raw);
  if (baseUrl === undefined) {
    throw configurationError("url_invalid", "Cloud URL must be an absolute HTTPS base URL with a plain path.");
  }
  return { baseUrl, token };
}

/**
 * Wait for this hosted run's completion signal and return its JSON payload.
 *
 * ```ts
 * import { waitForSignal } from "@relayflows/surface/signals";
 * const done = await waitForSignal("native_done");
 * ```
 *
 * Call it in the authored flow body, not inside an `f.run` command: only the
 * authored process holds the run-bound read token. The wait has no overall
 * deadline; pass `signal` (e.g. `AbortSignal.timeout(ms)`) to bound it.
 */
export async function waitForSignal(name: string, options: WaitForSignalOptions = {}): Promise<unknown> {
  const runId = options.runId ?? process.env[HOSTED_RUN_ID_ENV];
  if (runId === undefined || runId === "") {
    throw configurationError("run_id_missing",
      `waitForSignal needs a Cloud run ID: pass { runId }, or call it from a hosted run, where ${HOSTED_RUN_ID_ENV} is set.`);
  }
  return holdSignalWait(runId, name, options, { connection: () => hostedConnection(options) });
}
