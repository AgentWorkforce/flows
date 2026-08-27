// RED — `cloud worker start --daemon` reports a pid for a process that is
//       already dead: the bun-compiled binary re-execs itself with a virtual
//       `$bunfs` argv.
//
// BUG      startDaemon() spawns `process.execPath` and passes `process.argv[1]`
//          as the first argument. Under `bun build --compile`, execPath is the
//          binary and argv[1] is the virtual path
//          `/$bunfs/root/agent-relay-darwin-arm64`, so the child parses that
//          path as a command name and exits immediately, while the parent has
//          already printed success.
// EVIDENCE AgentWorkforce/relay packages/cli/src/cli/commands/cloud-worker.ts
//            :266  `process.argv[1] ?? 'agent-relay',`
//            :279  `child = input.deps.spawnProcess(process.execPath, args, {`
//            :396  deps.log('Cloud worker daemon started: ' + daemonRecord.pid)
//          Observed 2026-08-27 on the darwin-arm64 compiled binary:
//            error: unknown command '/$bunfs/root/agent-relay-darwin-arm64'
//          while the CLI printed "Cloud worker daemon started: <pid>".
//          Covenant 2: a "succeeded" that did nothing.
// UPSTREAM to file — relay CLI
//
// This flow PASSES while the bug is present.
//
// RUN-WHEN: gate-1, gate-6, gate-7 (darwin-arm64 placement)

import { flow } from "@relayflows/surface";

export default flow(
  "regressions/worker-daemon-bun-argv.red",
  {
    identity: "regressions/worker-daemon-bun-argv",
    tools: { relayfile: ["agentworkforce-cloud"] },
    // gate 7: this step must land on a darwin-arm64 host running the compiled
    // binary. The bug does not exist under `bun run` or under node.
    workspace: "sandbox:darwin-arm64",
    budget: "$0.05/run",
  },
  async (f) => {
    const started = await f
      .run("agent-relay cloud worker start --daemon 2>&1")
      .gate(
        (out) => /Cloud worker daemon started: \d+/.test(out),
        "the CLI claims the daemon started — this is the lie under test",
      );

    const pid = /Cloud worker daemon started: (\d+)/.exec(started)?.[1] ?? "0";

    await f
      .run(`ps -p ${pid} >/dev/null 2>&1 && echo alive || echo dead`)
      .gate(
        (state) => state.trim() === "dead",
        "the bug: the pid the CLI reported is already gone",
      );

    await f
      .run("agent-relay cloud worker logs --tail 40 2>&1")
      .gate(
        (log) => log.includes("unknown command '/$bunfs/root/agent-relay-darwin-arm64'"),
        "and the daemon log names the cause: argv[1] is a $bunfs virtual path",
      );

    // No process means no heartbeat: the cloud side never sees this worker.
    await f.cloud.workers
      .heartbeat({ workerId: "regression-daemon", as: "cli-bearer" })
      .gate(
        (hb) => hb.lastSeenAt === null,
        "and cloud liveness never observes the worker the CLI said it started",
      );

    return f.done("bug_reproduced");
  },
);
