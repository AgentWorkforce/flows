/**
 * Agent-relay HTTP transport for f.agent step dispatch (flows#385).
 *
 * The SDK's default agent path is a direct `child_process.spawn(cli, ...)`
 * in worker-cli.ts. That is unobservable — you cannot DM the spawned agent
 * mid-flight, and every ecosystem tool that wants to steer or watch it
 * ends up shelling out to the `agent-relay` CLI, which is fragile.
 *
 * This module speaks to agent-relay via structured HTTP: the same call
 * shape the `mcp__agent-relay__spawn` MCP tool posts. The SDK becomes a
 * first-class agent-relay participant, registered under a derived agent
 * name a caller can DM against.
 *
 * Scope: spawn + close. Streaming inbox and observation are follow-ups.
 */

export type AgentTransport = 'direct' | 'relay';

export interface AgentRelaySpawnRequest {
  /** Registered agent name in the workspace. */
  name: string;
  /** CLI to launch. */
  cli: 'claude' | 'codex' | 'gemini' | 'aider' | 'goose' | 'grok' | 'opencode';
  /** Initial task instructions. */
  task: string;
  /** Optional model powering the worker. */
  model?: string;
  /** Optional working directory for the spawned worker process. */
  worker_cwd?: string;
  /** Optional target fleet node name. */
  target_node?: string;
  /** Declared objective for workforce reporting. */
  objective?: string;
  /** Declared role for workforce reporting. */
  role?: string;
  /** Declared project for workforce reporting. */
  project?: string;
  /** Declared workstream for workforce reporting. */
  workstream?: string;
}

export interface AgentRelayEnv {
  /** `RELAY_BASE_URL` env; defaults to https://cast.agentrelay.com. */
  baseUrl?: string;
  /** `RELAY_API_KEY` env (rk_live_...). Required. */
  apiKey?: string;
  /** `RELAY_DEFAULT_WORKSPACE` env; workspace scoping for the spawn. */
  workspaceId?: string;
  /** Optional bearer token for the individual agent identity, if pre-registered. */
  agentToken?: string;
}

export interface AgentSpawnHandle {
  /** Registered agent name in the workspace — DM this to steer. */
  readonly registeredName: string;
  /** Invocation id returned by relay; use for status polling. */
  readonly invocationId: string;
  /** Best-effort deregistration/notification. */
  close(): Promise<void>;
}

export class AgentRelayTransportError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AgentRelayTransportError';
  }
}

/**
 * Read the same env the relay MCP already consumes. Explicit override wins.
 * Missing RELAY_API_KEY refuses immediately — the transport cannot proceed
 * unauthenticated and the direct-spawn fallback is a separate decision.
 */
export function readAgentRelayEnv(env: NodeJS.ProcessEnv = process.env): Required<Pick<AgentRelayEnv, 'baseUrl' | 'apiKey'>> & AgentRelayEnv {
  const baseUrl = env['RELAY_BASE_URL']?.trim() || 'https://cast.agentrelay.com';
  const apiKey = env['RELAY_API_KEY']?.trim();
  if (!apiKey) {
    throw new AgentRelayTransportError(
      'agent-relay transport requires RELAY_API_KEY in the environment; falling back to direct transport is the caller\'s responsibility.',
    );
  }
  return {
    baseUrl,
    apiKey,
    workspaceId: env['RELAY_DEFAULT_WORKSPACE']?.trim() || undefined,
    agentToken: env['RELAY_AGENT_TOKEN']?.trim() || undefined,
  };
}

/**
 * Spawn a worker via agent-relay HTTP. The endpoint mirrors what the
 * `mcp__agent-relay__spawn` MCP tool wraps — a POST that requests a fleet
 * node dispatch. Returns a handle keyed on the registered agent name.
 *
 * The `fetch` argument is injected so tests can mock the transport without
 * hitting the network.
 */
export async function agentRelaySpawn(
  request: AgentRelaySpawnRequest,
  env: AgentRelayEnv & { fetch?: typeof fetch } = {},
): Promise<AgentSpawnHandle> {
  const resolved = { ...readAgentRelayEnv(), ...env };
  const url = new URL('/api/v1/agents/spawn', resolved.baseUrl).toString();
  const doFetch: typeof fetch = env.fetch ?? (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch;
  if (typeof doFetch !== 'function') {
    throw new AgentRelayTransportError('global fetch is unavailable; provide { fetch } explicitly.');
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'authorization': `Bearer ${resolved.apiKey}`,
  };
  if (resolved.workspaceId !== undefined) headers['x-relay-workspace'] = resolved.workspaceId;
  if (resolved.agentToken !== undefined) headers['x-relay-agent-token'] = resolved.agentToken;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });
  } catch (cause) {
    throw new AgentRelayTransportError(
      `agent-relay spawn network error at ${url}: ${(cause as Error).message ?? String(cause)}`,
      cause,
    );
  }

  if (response.status < 200 || response.status >= 300) {
    let body: string;
    try { body = (await response.text()).slice(0, 512); } catch { body = '<no body>'; }
    throw new AgentRelayTransportError(
      `agent-relay spawn refused with status ${response.status}: ${body}`,
    );
  }

  let json: { invocation?: { invocationId?: string; input?: { name?: string } } };
  try { json = await response.json() as typeof json; } catch (cause) {
    throw new AgentRelayTransportError(
      'agent-relay spawn response was not JSON',
      cause,
    );
  }
  const invocationId = json.invocation?.invocationId;
  const registeredName = json.invocation?.input?.name ?? request.name;
  if (typeof invocationId !== 'string' || invocationId.length === 0) {
    throw new AgentRelayTransportError(
      'agent-relay spawn response missing invocation.invocationId',
    );
  }

  return {
    registeredName,
    invocationId,
    async close(): Promise<void> {
      // Best-effort: post to /api/v1/invocations/<id>/close if defined server-side;
      // no throw on error because the invocation may already be terminal.
      const closeUrl = new URL(`/api/v1/invocations/${encodeURIComponent(invocationId)}/close`, resolved.baseUrl).toString();
      try {
        await doFetch(closeUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ reason: 'sdk_transport_close' }),
        });
      } catch {
        // Deliberate: close is advisory in this minimum-viable slice.
      }
    },
  };
}

/**
 * Derive a workspace-unique agent name from a run identity + step id. The
 * result is stable across replays of the same step so DMs can be addressed
 * even during retries.
 */
export function deriveAgentName(runId: string, stepId: string): string {
  // Keep readable + collision-safe: prefix with 'flow-' and use lower-kebab.
  const clean = (s: string): string => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `flow-${clean(runId)}-${clean(stepId)}`.slice(0, 96);
}
