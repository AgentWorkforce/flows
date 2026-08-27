// RED — the workspace key repair endpoint answers an untyped 500, so every
//        cloud workflow launch for the workspace fails with a status line and
//        no condition.
//
// BUG      Agent Relay Cloud re-registers a workspace's stored relaycast key
//          before every launch. The hosted gateway's internal maintenance route
//          performs its D1 write with NO try/catch, so a database error — the
//          `workspaces_api_key_hash_unique` violation raised when the pushed key
//          is already registered to a different workspace row — escapes the
//          handler, escapes the worker `fetch`, and Cloudflare returns a bare
//          500 with a non-JSON body. The caller can only print the HTTP status
//          text. Covenant 1: the error names no condition in the author's
//          vocabulary, so the operator retries a launch that can never succeed.
//
//          The condition is entirely knowable at the point of failure — the
//          route already knows the workspace id, the key, and the constraint
//          that rejected it — and it is a permanent, not transient, state. It
//          should be a typed 4xx that says the key belongs to another
//          workspace, so the caller re-mints instead of retrying forever.
//
// EVIDENCE AgentWorkforce/relaycast-cloud
//            packages/relaycast/src/fleet/routes.ts:523 (ensureWorkspaceKey)
//            packages/relaycast/src/fleet/routes.ts:550-566
//              const apiKeyHash = await hashToken(apiKey);
//              const existing = await env.DB.prepare('SELECT id FROM workspaces …
//              await env.DB.prepare('UPDATE workspaces SET api_key_hash = ? WHERE id = ?')
//                .bind(apiKeyHash, existing.id).run();   // ← unguarded
//            packages/relaycast/src/fleet/routes.ts:587-594 (dispatch)
//            packages/relaycast/src/entrypoints/cloudflare.ts:182-183
//              const fleetResponse = await handleFleetGatewayRequest(request, env);
//                                                              // ← no try/catch
//          AgentWorkforce/cloud
//            packages/web/lib/workflows/relay-workspace.ts:222-243 (the caller)
//            packages/web/lib/workflows/relay-workspace.ts:238-241
//              const message = payload?.error?.message || response.statusText || "unknown";
//              throw new Error(`Relaycast workspace key repair failed: ${response.status} ${message}`);
//            — `statusText` is only reached when the body carries no
//              error.message, i.e. when the response is NOT the route's own
//              typed JSON. That is the signature of an unhandled exception.
//
//          Observed 2026-08-27, 3 launches out of 3, workflow_launch_jobs:
//            9a26d44d  manual submit 18:24Z  status failed
//            0c96a292  cron           18:00Z  status launching
//            09e842f0  cron           18:00Z  status launching
//          all carrying last_error:
//            "Relaycast workspace key repair failed: 500 Internal Server Error"
//          App workspace 50587328-441d-4acb-b8f3-dbe1b3c5de99
//            → relay workspace rw_7ccfea89, which EXISTS in the prod D1
//              `relaycast-cloud` (plan enterprise), so the UPDATE branch runs,
//              not the INSERT branch.
//
// NOT REPRODUCING as of 2026-08-27 18:46-18:52Z. Four launches were fired with
// a `wrangler tail` attached to `relaycast-cloud-api`; all four reached
// POST /internal/workspaces/rw_7ccfea89/api-key, all four answered 200 with
// zero exceptions, and one run reached `running` with a sandbox. Across the
// whole window rw_7ccfea89's stored api_key_hash was UNCHANGED (800c08fc13…
// before and after), so each push was a self-update — and a self-update can
// never violate workspaces_api_key_hash_unique. That disfavours the
// constraint-collision reading of the original 500s and favours a transient
// fault on the same unguarded path, unless the control plane's stored key was
// different at 18:00-18:24Z and has since changed. That last possibility is
// unverifiable from here: the prod Neon row was not reachable (the on-disk
// NEON_APP_DATABASE_URL points at a dev branch).
//
// The DEFECT is unchanged either way, and is what this pair exists for: the
// route runs its D1 statements with no try/catch, so ANY database fault —
// permanent or transient — reaches the operator as a bare, untyped
// "500 Internal Server Error". A transient fault is the worse case, because
// the caller cannot tell it apart from a permanent one and retries forever,
// which is exactly what these three jobs did.
//
// This flow therefore reproduces only while the underlying fault window is
// open. Judge the defect by reading routes.ts, not by this flow's exit code.
//
// UPSTREAM to file — relaycast-cloud
//
// This flow PASSES while the bug is present (see NOT REPRODUCING above).
//
// RUN-WHEN: gate-1, gate-6 (a relayfile adapter for the relaycast gateway),
//           gate-8 (the internal bearer resolved from a mount, not ambient env)

import { flow } from "@relayflows/surface";
import { nested, readProbe, relaycastProbe, storedRelaycastKey } from "./probe.js";

/** khaliq@agentrelay.com → relay workspace behind app ws 50587328-…. */
const RELAY_WORKSPACE = "rw_7ccfea89";

const REPAIR_PATH = `/internal/workspaces/${RELAY_WORKSPACE}/api-key`;

export default flow(
  "regressions/relaycast-workspace-key-repair-500.red",
  {
    identity: "regressions/relaycast-workspace-key-repair-500",
    tools: { relayfile: ["agentworkforce-cloud", "relaycast-gateway"] },
    budget: "$0.05/run",
  },
  async (f) => {
    // 1. The failure itself, on the exact contract the launch path uses.
    await f
      .run(
        relaycastProbe({
          method: "POST",
          path: REPAIR_PATH,
          principal: "cloud-control-plane",
          rawJson: `{"api_key":"${storedRelaycastKey(RELAY_WORKSPACE)}"}`,
        }),
      )
      .gate(
        (out) => readProbe(out).status === 500,
        "the bug: re-registering a stored key 500s, blocking every launch",
      )
      .gate(
        (out) => nested(readProbe(out).body, "error", "code") === undefined,
        "and the body carries no error.code — an unhandled throw, not a typed failure",
      )
      .gate(
        (out) => nested(readProbe(out).body, "error", "message") === undefined,
        "so the caller falls through to response.statusText and prints 'Internal Server Error'",
      );

    // 2. Control — the route is deployed, reachable, and its AUTH path is
    //    typed. This is what rules out 'endpoint missing', 'worker down' and
    //    'internal secret unconfigured' (which is its own typed 503) as the
    //    cause of the 500 above.
    await f
      .run(
        relaycastProbe({
          method: "POST",
          path: REPAIR_PATH,
          principal: "invalid",
          rawJson: '{"api_key":"rk_live_probe"}',
        }),
      )
      .gate(
        (out) => readProbe(out).status === 401,
        "a wrong internal bearer is answered 401, not 500 — the secret is configured",
      )
      .gate(
        (out) => nested(readProbe(out).body, "error", "code") === "unauthorized",
        "with a typed code, proving the route CAN name a condition when it handles one",
      );

    // 3. Control — the VALIDATION path is typed too. Only the database write
    //    is unguarded, which localises the defect to the D1 statements.
    await f
      .run(
        relaycastProbe({
          method: "POST",
          path: REPAIR_PATH,
          principal: "cloud-control-plane",
          rawJson: '{"api_key":"not-an-rk-live-key"}',
        }),
      )
      .gate(
        (out) => readProbe(out).status === 400,
        "a malformed key is a typed 400",
      )
      .gate(
        (out) => nested(readProbe(out).body, "error", "code") === "invalid_request",
        "so every declared failure is typed — and the 500 is the one path that is not",
      );

    return f.done("bug_reproduced");
  },
);
