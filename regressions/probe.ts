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
