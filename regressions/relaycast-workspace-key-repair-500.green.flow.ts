// GREEN — the repair either succeeds on the caller's contract, or names its
//         condition in a typed 4xx. It is never an untyped 500.
//
// BUG      see relaycast-workspace-key-repair-500.red.flow.ts
// EVIDENCE AgentWorkforce/relaycast-cloud
//            packages/relaycast/src/fleet/routes.ts:550-566
//              (unguarded SELECT / UPDATE / INSERT — a D1 constraint error
//               escapes as a bare 500)
//            packages/relaycast/src/entrypoints/cloudflare.ts:182-183
//              (handleFleetGatewayRequest is not wrapped)
//          AgentWorkforce/cloud
//            packages/web/lib/workflows/relay-workspace.ts:222-243
//              (treats the call as failed unless response.ok AND
//               payload.data.workspace_id === relaycastWorkspaceId)
//          Jobs 9a26d44d / 0c96a292 / 09e842f0, 2026-08-27,
//            "Relaycast workspace key repair failed: 500 Internal Server Error"
// UPSTREAM to file — relaycast-cloud
//
// The fix wraps the D1 statements and maps the one constraint that can fire —
// `workspaces_api_key_hash_unique` — onto a typed 409 naming the condition, so
// the control plane learns the key belongs to another workspace and re-mints
// instead of retrying a launch that can never succeed. Any other database
// error still fails, but as typed JSON carrying a code, so the caller can print
// something better than an HTTP status line.
//
// A well-formed success is equally acceptable, and is the expected outcome once
// the underlying key/workspace binding is repaired: this pair closes on either,
// and on neither while the endpoint throws.
//
// This flow FAILS while the bug is present (untyped 500) and PASSES once the
// endpoint answers a well-formed success or a typed 4xx.
//
// RUN-WHEN: gate-1, gate-6 (a relayfile adapter for the relaycast gateway),
//           gate-8 (the internal bearer resolved from a mount, not ambient env)

import { flow } from "@relayflows/surface";
import { nested, readProbe, relaycastProbe, storedRelaycastKey } from "./probe.js";

/** khaliq@agentrelay.com → relay workspace behind app ws 50587328-…. */
const RELAY_WORKSPACE = "rw_7ccfea89";

const REPAIR_PATH = `/internal/workspaces/${RELAY_WORKSPACE}/api-key`;

/** The typed conditions the route is allowed to answer for a valid request. */
const TYPED_REPAIR_CODES = [
  // The pushed key is already registered to a DIFFERENT workspace row. The
  // constraint that raises it today is workspaces_api_key_hash_unique.
  "api_key_registered_to_another_workspace",
];

export default flow(
  "regressions/relaycast-workspace-key-repair-500.green",
  {
    identity: "regressions/relaycast-workspace-key-repair-500",
    tools: { relayfile: ["agentworkforce-cloud", "relaycast-gateway"] },
    budget: "$0.05/run",
  },
  async (f) => {
    // 1. The repair call the launch path makes, on the exact caller contract.
    const repair = await f
      .run(
        relaycastProbe({
          method: "POST",
          path: REPAIR_PATH,
          principal: "cloud-control-plane",
          rawJson: `{"api_key":"${storedRelaycastKey(RELAY_WORKSPACE)}"}`,
        }),
      )
      .gate(
        (out) => readProbe(out).status !== 500,
        "the repair never answers an untyped 500 — a knowable condition must be named",
      )
      .gate((out) => {
        const { status } = readProbe(out);
        return status < 500;
      }, "and never any 5xx: the failing condition is permanent and knowable, not a server fault")
      .gate((out) => {
        const { status, body } = readProbe(out);
        if (status === 200 || status === 201) {
          // Success must satisfy the caller's contract verbatim, or cloud
          // treats it as a failure anyway (relay-workspace.ts:237).
          return nested(body, "ok") === true
            && nested(body, "data", "workspace_id") === RELAY_WORKSPACE;
        }
        // Otherwise it must be a TYPED refusal the caller can act on.
        return TYPED_REPAIR_CODES.includes(String(nested(body, "error", "code") ?? ""));
      }, "either a success echoing the workspace id, or a typed code the control plane can branch on");

    // 2. Whatever the outcome, the body is the route's own JSON — never
    //    Cloudflare's error page. This is the gate that actually fails today.
    await f
      .run("printf ok")
      .gate(
        () => nested(readProbe(repair).body, "ok") !== undefined,
        "the response is the route's typed envelope, so an unhandled throw cannot pass as one",
      )
      .gate(() => {
        const { status, body } = readProbe(repair);
        if (status === 200 || status === 201) return true;
        // A refusal has to carry a human-readable message too — the caller
        // prints payload.error.message and must not fall back to statusText.
        return String(nested(body, "error", "message") ?? "").length > 0;
      }, "a refusal carries a message, so the caller never prints a bare HTTP status line");

    // 3. The already-typed paths must stay typed — a fix that swallows every
    //    error into one code would regress these.
    await f
      .run(
        relaycastProbe({
          method: "POST",
          path: REPAIR_PATH,
          principal: "invalid",
          rawJson: '{"api_key":"rk_live_probe"}',
        }),
      )
      .gate((out) => readProbe(out).status === 401, "a wrong internal bearer stays 401")
      .gate(
        (out) => nested(readProbe(out).body, "error", "code") === "unauthorized",
        "with its own code",
      );

    await f
      .run(
        relaycastProbe({
          method: "POST",
          path: REPAIR_PATH,
          principal: "cloud-control-plane",
          rawJson: '{"api_key":"not-an-rk-live-key"}',
        }),
      )
      .gate((out) => readProbe(out).status === 400, "a malformed key stays 400")
      .gate(
        (out) => nested(readProbe(out).body, "error", "code") === "invalid_request",
        "with its own code — the three conditions remain distinguishable",
      );

    return f.done("bug_fixed");
  },
);
