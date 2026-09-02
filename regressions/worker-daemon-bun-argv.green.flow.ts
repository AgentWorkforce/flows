// GREEN — `cloud worker start --daemon` starts a daemon that is alive and
//         visible to cloud liveness.
//
// BUG      see worker-daemon-bun-argv.red.flow.ts
// EVIDENCE packages/cli/src/cli/commands/cloud-worker.ts:266,279,396
// UPSTREAM to file — relay CLI
//
// This flow FAILS while the bug is present (the daemon dies before the liveness
// gate) and PASSES once the re-exec resolves a real executable path instead of
// `process.argv[1]`. Reporting a pid is not the acceptance criterion; a worker
// that heartbeats is.
//
// RUN-WHEN: gate-1, gate-6, gate-7 (darwin-arm64 placement)

import { flow } from "@relayflows/surface";

export default flow(
  "regressions/worker-daemon-bun-argv.green",
  {
    identity: "regressions/worker-daemon-bun-argv",
    tools: { relayfile: ["agentworkforce-cloud"] },
    workspace: "sandbox:darwin-arm64",
    budget: "$0.05/run",
  },
  async (f) => {
    const started = await f
      .run("agent-relay cloud worker start --daemon 2>&1")
      .gate(
        (out) => /Cloud worker daemon started: \d+/.test(out),
        "the CLI reports a pid",
      );

    const pid = /Cloud worker daemon started: (\d+)/.exec(started)?.[1] ?? "0";

    await f
      .run(`ps -p ${pid} >/dev/null 2>&1 && echo alive || echo dead`)
      .gate(
        (state) => state.trim() === "alive",
        "the reported pid must be a live process — the report must be true",
      );

    await f
      .run("agent-relay cloud worker logs --tail 40 2>&1")
      .gate(
        (log) => !log.includes("unknown command"),
        "and the daemon must not have re-execed itself into an unknown command",
      );

    // The durable half: local liveness is not enough, cloud has to see it.
    // `awaitHeartbeat` compiles to a kernel wait, so this parks rather than polls.
    await f.cloud.workers
      .awaitHeartbeat({ workerId: "regression-daemon", as: "cli-bearer", within: "90s" })
      .gate(
        (hb) => hb.lastSeenAt !== null && hb.status === "online",
        "cloud liveness must observe the daemon the CLI said it started",
      );

    await f.run(`kill ${pid} 2>/dev/null || true`);
    return f.done("success");
  },
);
