/**
 * Observer-link support for `flows run`: mint a scoped read-only observer token
 * from a Relaycast workspace admin key, then print
 * `Observer: <url>?key=<ot_live_...>` on stdout so an operator can drop into the
 * Relaycast observer dashboard with the live-stream credential pre-filled.
 *
 * The workspace admin key (`rk_live_*`) is refused by the realtime endpoint —
 * only an `ot_live_*` observer token with `stream:read` may open the workspace
 * stream. So we do the same thing the Relaycast observer dashboard does when a
 * workspace admin logs in with their admin key: mint a fresh, uniquely-named,
 * scoped, short-lived observer token on their behalf and hand *that* to the
 * URL. The workspace admin key never leaves the operator's machine.
 *
 * Everything here is best-effort. A missing workspace key means "no observer
 * link, silently" — this is a parity feature relaying v1's convenience, not a
 * requirement of a local run. A mint failure emits a labeled diagnostic to
 * stderr and continues; a run must never fail because the observer link failed.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Scopes the minted token carries. Mirrors the observer dashboard's set. */
const OBSERVER_SCOPES = [
  'stream:read',
  'messages:read',
  'threads:read',
  'dms:read',
  'channels:read',
  'search:read',
  'agents:read',
  'nodes:read',
  'deliveries:read',
  'activity:read',
  'files:read',
  'reactions:read',
] as const;

/** Token lifetime for a `flows run` session. 24h is well past the longest run. */
const OBSERVER_TOKEN_TTL_MS = 60 * 60 * 24 * 1000;

/** Default Relaycast API base; overridable via `RELAYCAST_API_URL`. */
const DEFAULT_RELAYCAST_URL = 'https://agentrelay.com';

/** Bounded so a stalled Relaycast API cannot delay the RUN summary. */
const MINT_TIMEOUT_MS = 5_000;

export interface ObserverLinkEnv {
  workspaceKey?: string;
  baseUrl?: string;
  /** `FLOWS_NO_OBSERVER=1` suppresses the mint even when a key is present. */
  suppressed: boolean;
}

/**
 * Path to the `agent-relay` local workspace-key store. Structure:
 * `{ active: string, workspaces: { [name]: { key: string } } }`. Written
 * by `agent-relay workspace set_key` / `agent-relay workspace join`; the
 * canonical file the `@agent-relay/cloud` package reads via
 * `resolveActiveWorkspaceKey`. Verified against
 * `packages/cloud/src/workspace-store.ts` in `AgentWorkforce/relay`.
 *
 * Respects `AGENT_RELAY_HOME` so a caller can point at a different store
 * for tests without touching the real one. Falls back to
 * `~/.agentworkforce/relay/workspaces.json` -- the same default that
 * package uses.
 */
export function agentRelayWorkspaceStorePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = env['AGENT_RELAY_HOME'] ?? join(homedir(), '.agentworkforce/relay');
  return join(dir, 'workspaces.json');
}

/**
 * Shape of the `workspaces.json` file. Only the fields we depend on are
 * declared; other keys are ignored. Kept structural so a type mismatch on
 * an untrusted disk read falls into the "no cloud key readable" branch
 * rather than throwing.
 */
interface AgentRelayWorkspaceStore {
  active?: string;
  workspaces?: Record<string, { key?: string } | undefined>;
}

/**
 * Read the active workspace key from the `agent-relay cloud login` /
 * `agent-relay workspace set_key` store. Returns `undefined` on every
 * failure mode -- file absent, unreadable, malformed JSON, no active
 * workspace, active workspace has no key, key is empty -- so the caller
 * can silently fall through to "no observer link" the same way an unset
 * `RELAYCAST_WORKSPACE_KEY` does.
 *
 * A file-shape mismatch is INTENTIONALLY not a hard error: `agent-relay`
 * may extend this file in future without warning, and refusing a flow
 * because a fallback credential store looked odd would be strictly worse
 * than falling back to the explicit env var (which is the primary path).
 */
export function readAgentRelayWorkspaceKey(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = defaultReadFile,
): string | undefined {
  let raw: string;
  try {
    raw = readFile(agentRelayWorkspaceStorePath(env));
  } catch {
    return undefined;
  }
  let parsed: AgentRelayWorkspaceStore;
  try {
    parsed = JSON.parse(raw) as AgentRelayWorkspaceStore;
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const activeName = parsed.active;
  if (typeof activeName !== 'string' || activeName === '') return undefined;
  const workspaces = parsed.workspaces;
  if (typeof workspaces !== 'object' || workspaces === null) return undefined;
  const entry = workspaces[activeName];
  if (typeof entry !== 'object' || entry === null) return undefined;
  const key = entry.key;
  if (typeof key !== 'string') return undefined;
  const trimmed = key.trim();
  return trimmed === '' ? undefined : trimmed;
}

function defaultReadFile(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

/**
 * Options controlling `resolveObserverLinkEnv`'s fallback behavior. The
 * `readWorkspaceKey` seam is what the tests inject to simulate presence,
 * absence, and malformed shapes of the on-disk store without touching the
 * real home directory.
 */
export interface ResolveObserverLinkEnvOptions {
  readWorkspaceKey?: (env: NodeJS.ProcessEnv) => string | undefined;
}

/**
 * Env-first observer link resolution with an `agent-relay` cloud fallback.
 *
 * Priority (from the task spec, explicit beats implicit):
 * 1. `RELAYCAST_WORKSPACE_KEY` if set and non-empty.
 * 2. Active workspace key from `~/.agentworkforce/relay/workspaces.json`
 *    (populated by `agent-relay cloud login` + `agent-relay workspace
 *    set_key`), when readable.
 * 3. Nothing -- silent skip, same as an unset primary env var.
 *
 * `FLOWS_NO_OBSERVER=1` still suppresses regardless of source.
 */
export function resolveObserverLinkEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveObserverLinkEnvOptions = {},
): ObserverLinkEnv {
  const primary = readObserverLinkEnv(env);
  if (primary.workspaceKey !== undefined || primary.suppressed) {
    return primary;
  }
  const readWorkspaceKey = options.readWorkspaceKey ?? readAgentRelayWorkspaceKey;
  const fallback = readWorkspaceKey(env);
  if (fallback === undefined) return primary;
  return {
    ...primary,
    workspaceKey: fallback,
  };
}

/**
 * Read the observer-link config from the environment. Both trims and
 * emptiness-checks the workspace key so a `RELAYCAST_WORKSPACE_KEY=` with no
 * value reads the same as unset (no observer link, silently).
 */
export function readObserverLinkEnv(
  env: NodeJS.ProcessEnv = process.env,
): ObserverLinkEnv {
  const rawKey = env['RELAYCAST_WORKSPACE_KEY'];
  const workspaceKey = typeof rawKey === 'string' ? rawKey.trim() : '';
  const rawUrl = env['RELAYCAST_API_URL'];
  const baseUrl = typeof rawUrl === 'string' && rawUrl.trim() !== ''
    ? rawUrl.trim()
    : undefined;
  return {
    ...(workspaceKey !== '' ? { workspaceKey } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    suppressed: env['FLOWS_NO_OBSERVER'] === '1',
  };
}

/**
 * Minimal `fetch` shape we depend on. Kept structural so tests can inject a
 * mock without pulling in a fetch replacement library.
 */
export type ObserverFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface MintObserverOptions {
  workspaceKey: string;
  baseUrl?: string;
  fetch?: ObserverFetch;
  now?: () => number;
  /** Called for the token's uniquely-suffixed name; injectable for tests. */
  uuid?: () => string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface MintObserverOutcome {
  observerUrl?: string;
  /**
   * A short diagnostic to log when mint failed. `undefined` on success or on
   * "no observer link is possible" (missing key/suppressed) so the caller can
   * distinguish silent-skip from "warn about the miss".
   */
  warning?: string;
}

/**
 * Mint an `ot_live_*` observer token via `POST /v1/observer-tokens` and return
 * the observer dashboard URL that pre-fills it. Any failure — 4xx/5xx from the
 * engine, malformed response, network error, timeout — returns a `warning`
 * string and no URL. The caller must not fail the run on `warning`.
 */
export async function mintObserverUrl(
  options: MintObserverOptions,
): Promise<MintObserverOutcome> {
  const doFetch: ObserverFetch = options.fetch ?? ((globalThis as unknown as {
    fetch: ObserverFetch;
  }).fetch);
  if (typeof doFetch !== 'function') {
    return { warning: 'no fetch implementation available' };
  }

  const rawBase = options.baseUrl ?? DEFAULT_RELAYCAST_URL;
  let mintUrl: URL;
  let observerBase: URL;
  try {
    mintUrl = new URL('/v1/observer-tokens', rawBase);
    observerBase = new URL('/observer', rawBase);
  } catch {
    return { warning: `invalid RELAYCAST_API_URL "${rawBase}"` };
  }

  const uuid = (options.uuid ?? defaultUuid)();
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? MINT_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline])
    : deadline;

  const payload = {
    name: `flows-run-${uuid}`,
    description: 'Auto-minted by `flows run` for the observer dashboard link.',
    scopes: OBSERVER_SCOPES,
    filters: { include_dms: true },
    expires_at: new Date(now() + OBSERVER_TOKEN_TTL_MS).toISOString(),
  };

  let response: Awaited<ReturnType<ObserverFetch>>;
  try {
    response = await doFetch(mintUrl.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.workspaceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    return { warning: `network error: ${errorMessage(error)}` };
  }

  if (!response.ok) {
    return { warning: `mint API returned HTTP ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { warning: `malformed response: ${errorMessage(error)}` };
  }

  const token = pickToken(body);
  if (token === undefined) {
    return { warning: 'mint API response missing ot_live_ token' };
  }

  // `URL.searchParams.set` percent-encodes any exotic characters the token
  // could carry. It also collapses the leading `/observer` path correctly.
  observerBase.searchParams.set('key', token);
  return { observerUrl: observerBase.toString() };
}

/**
 * Pick `data.token` from a `POST /v1/observer-tokens` response, refusing any
 * shape that is not a plain `ot_live_*` string. Anything else is treated as
 * "response too weird to trust" and produces no URL.
 */
function pickToken(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const data = (body as Record<string, unknown>)['data'];
  if (typeof data !== 'object' || data === null) return undefined;
  const token = (data as Record<string, unknown>)['token'];
  if (typeof token !== 'string' || !token.startsWith('ot_live_')) return undefined;
  return token;
}

function defaultUuid(): string {
  // `crypto.randomUUID()` is available on every Node 20+ target the SDK
  // supports. The token name is not a security surface — it only has to be
  // unique per (workspace, name) — so the fallback is a plain timestamp.
  const c = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? String(Date.now());
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'unknown error';
}
