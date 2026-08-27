// Shared shell probe for the regression flows.
//
// A red flow has to judge a *response*, not be killed by it. The v2 surface has
// no "expect this declared failure" form (see README, "What the dialect cannot
// say yet"), so every probe is a deterministic step that always exits 0 and
// prints `<body>\n<status>`. The postfix `.gate()` then judges the observed
// response — verification as control flow, exactly as RFC-0001 §1 intends.
//
// Auth is a mount read, never an ambient env var (gate 8: no ambient env
// inheritance). The relayfile adapter for AgentWorkforce cloud exposes each
// principal's bearer at `<mount>/principals/<name>/token`, so the filesystem
// path IS the permission (SURFACE.md §2.3).

export const CLOUD_MOUNT = "mnt/agentworkforce-cloud";

export interface ProbeResult {
  status: number;
  body: string;
}

/** Build the deterministic command for one authenticated probe. */
export function probe(input: {
  method: string;
  path: string;
  /** Principal directory under `<mount>/principals/` — the credential scope. */
  principal: string;
  json?: unknown;
}): string {
  const payload = input.json === undefined ? "" : ` -d '${JSON.stringify(input.json)}'`;
  return [
    "curl -sS -w '\\n%{http_code}'",
    `-X ${input.method}`,
    `"$(cat ${CLOUD_MOUNT}/base_url)${input.path}"`,
    `-H "Authorization: Bearer $(cat ${CLOUD_MOUNT}/principals/${input.principal}/token)"`,
    "-H 'Content-Type: application/json'",
    payload,
  ].join(" ").trim();
}

/** Split a probe step's stdout back into status + body. */
export function readProbe(stdout: string): ProbeResult {
  const lines = stdout.trimEnd().split("\n");
  const status = Number(lines.pop());
  return { status, body: lines.join("\n") };
}

/** Read one top-level field of a JSON response body; `undefined` if absent. */
export function field(body: string, key: string): unknown {
  try {
    return (JSON.parse(body) as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Relaycast hosted gateway (cast.agentrelay.com).
//
// The internal maintenance API is guarded by a shared bearer, not a user
// session, so it is still a *principal* in the gate-8 sense: the cloud control
// plane is the only caller allowed to present it. Keeping it at
// `<mount>/principals/<name>/token` means the same rule holds as for every
// other credential here — the filesystem path IS the permission, and nothing is
// inherited from ambient env (SURFACE.md §2.3).
//
// The workspace API key being re-registered is itself a secret, so it is read
// from the cloud mount inline (`$(cat …)`) rather than written into the flow
// source: the mount read is the record, never the token (Appendix A rule 3).

export const RELAYCAST_MOUNT = "mnt/relaycast-gateway";

/** Shell expression yielding a relay workspace's stored relaycast API key. */
export function storedRelaycastKey(relayWorkspaceId: string): string {
  return `$(cat ${CLOUD_MOUNT}/relay-workspaces/${relayWorkspaceId}/relaycast_api_key)`;
}

/**
 * Build the deterministic command for one internal-API probe against the
 * relaycast gateway. Like `probe()`, it always exits 0 and prints
 * `<body>\n<status>` so a postfix gate can judge the observed response.
 */
export function relaycastProbe(input: {
  method: string;
  path: string;
  /** Principal directory under `<mount>/principals/` — the credential scope. */
  principal: string;
  /** Raw JSON body; may embed `$(cat …)` so no secret enters the flow source. */
  rawJson?: string;
}): string {
  const payload = input.rawJson === undefined ? "" : ` -d '${input.rawJson}'`;
  return [
    "curl -sS -w '\\n%{http_code}'",
    `-X ${input.method}`,
    `"$(cat ${RELAYCAST_MOUNT}/base_url)${input.path}"`,
    `-H "Authorization: Bearer $(cat ${RELAYCAST_MOUNT}/principals/${input.principal}/token)"`,
    "-H 'Content-Type: application/json'",
    payload,
  ].join(" ").trim();
}

/** Read a nested field of a JSON response body; `undefined` if absent. */
export function nested(body: string, ...path: string[]): unknown {
  try {
    let cursor: unknown = JSON.parse(body);
    for (const key of path) {
      if (typeof cursor !== "object" || cursor === null) return undefined;
      cursor = (cursor as Record<string, unknown>)[key];
    }
    return cursor;
  } catch {
    return undefined;
  }
}
