// Proactive rotation of short-lived Relaycast agent tokens (`at_live_`) in
// run-token mode. Relaycast #550 gives each agent token a 15-minute expiry,
// while a run can last hours, and run-token mode holds no workspace key that
// could take an identity over. So each agent token this process registered is
// rotated through `POST /v1/agents/:name/rotate-token`, authenticated by that
// agent's own current token, well before expiry. Schedule and failure policy
// mirror the relay broker (crates/broker/src/relaycast/agent_token_rotation.rs).
//
// Tokens live in process memory only and never appear in errors.
import type { RelayMessaging } from './relay.js';
import { RelaycastHttpError, relaycastBaseUrl, relaycastRequest, type AgentRegistration } from './run-token.js';

/** Rotate no later than this long before expiry. */
export const ROTATE_BEFORE_EXPIRY_MS = 5 * 60_000;
/** A token with no known expiry is rotated once after this delay to learn it. */
export const UNKNOWN_EXPIRY_PROBE_MS = 60_000;
/** Backoff after a transient rotation failure; Relaycast keeps the old token valid for a 60s grace window. */
export const ROTATION_RETRY_BACKOFFS_MS = [2_000, 5_000, 10_000, 20_000, 30_000] as const;

/**
 * Delay until rotation: two thirds of the remaining lifetime or
 * ROTATE_BEFORE_EXPIRY_MS before expiry, whichever is earlier. A token already
 * inside that window rotates immediately.
 */
export function rotationDelay(now: number, expiresAt: number): number {
  const lifetime = expiresAt - now;
  if (!(lifetime > 0)) return 0;
  return Math.min(lifetime * 2 / 3, Math.max(0, lifetime - ROTATE_BEFORE_EXPIRY_MS));
}

function parseExpiry(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : undefined;
}

export function isUnauthorized(error: unknown): boolean {
  const record = error as { status?: unknown; statusCode?: unknown } | null;
  return typeof record === 'object' && record !== null && (record.status === 401 || record.statusCode === 401);
}

export interface AgentTokenSessionOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** One agent's current token, rotated on a timer and on demand. */
export class AgentTokenSession {
  private token: string;
  private expiresAt: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<string> | undefined;
  private stopped = false;
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;

  constructor(readonly name: string, initial: AgentRegistration, options: AgentTokenSessionOptions = {}) {
    this.token = initial.token;
    this.expiresAt = parseExpiry(initial.tokenExpiresAt);
    this.base = relaycastBaseUrl(options.baseUrl);
    this.doFetch = options.fetch ?? ((...args) => fetch(...args));
    this.now = options.now ?? Date.now;
  }

  current(): string { return this.token; }

  /** Begin proactive rotation. */
  start(): void { this.schedule(); }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Rotate now (one attempt; concurrent callers share it) and return the new token. */
  rotate(): Promise<string> {
    this.inFlight ??= this.rotateOnce().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async rotateOnce(): Promise<string> {
    const path = `/v1/agents/${encodeURIComponent(this.name)}/rotate-token`;
    const data = await relaycastRequest(this.doFetch, this.base, this.token, 'POST', path, {}) as
      { token?: unknown; token_expires_at?: unknown } | undefined;
    if (typeof data?.token !== 'string' || !data.token.trim()) {
      throw new Error(`Relaycast agent token rotation for '${this.name}' returned no token.`);
    }
    // The previous token stays valid for Relaycast's grace window, so requests
    // already in flight with it still succeed.
    this.token = data.token;
    this.expiresAt = parseExpiry(data.token_expires_at);
    // A rotated token with no expiry comes from an engine that predates #550
    // and needs no further rotation.
    if (this.expiresAt === undefined) this.stop(); else this.schedule();
    return this.token;
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = this.expiresAt === undefined ? UNKNOWN_EXPIRY_PROBE_MS : rotationDelay(this.now(), this.expiresAt);
    this.timer = setTimeout(() => { void this.scheduledRotation(0); }, delay);
    this.timer.unref?.();
  }

  private async scheduledRotation(attempt: number): Promise<void> {
    this.timer = undefined;
    if (this.stopped) return;
    try {
      await this.rotate();
    } catch (error) {
      // 401/403/404 fail closed: run-token mode never takes over or re-registers.
      if (error instanceof RelaycastHttpError && [401, 403, 404].includes(error.status)) { this.stop(); return; }
      const expired = this.expiresAt !== undefined && this.expiresAt <= this.now();
      if (attempt >= ROTATION_RETRY_BACKOFFS_MS.length || expired || this.stopped) { this.stop(); return; }
      this.timer = setTimeout(() => { void this.scheduledRotation(attempt + 1); }, ROTATION_RETRY_BACKOFFS_MS[attempt]);
      this.timer.unref?.();
    }
  }
}

/**
 * A messaging facade that always uses the session's current token. The
 * underlying client is rebuilt whenever the token rotates; a 401 forces one
 * rotation and a single retry. Sends carry idempotency keys, so a retry
 * cannot duplicate a message.
 */
export function rotatingMessaging(session: AgentTokenSession,
  build: (agentToken: string) => RelayMessaging): RelayMessaging {
  let token = session.current();
  let client = build(token);
  const current = () => {
    const latest = session.current();
    if (latest !== token) { token = latest; client = build(latest); }
    return client;
  };
  async function call<T>(operation: (messaging: RelayMessaging) => Promise<T>): Promise<T> {
    try { return await operation(current()); } catch (error) {
      if (!isUnauthorized(error)) throw error;
      await session.rotate();
      return operation(current());
    }
  }
  return {
    agents: {
      register: input => call(m => m.agents.register(input)),
      delete: name => call(m => m.agents.delete(name)),
    },
    channels: {
      create: input => call(m => m.channels.create(input)),
      get: name => call(m => m.channels.get(name)),
      join: name => call(m => m.channels.join(name)),
    },
    messages: {
      direct: input => call(m => m.messages.direct(input)),
      send: input => call(m => m.messages.send(input)),
    },
  };
}
