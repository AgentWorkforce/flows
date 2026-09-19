// stuck-run-triage — why is this Cloud run not finishing?
//
// Written the night seven Software Garden runs sat in RUNNING for four hours
// while a sibling failed "relayfile ACL provisioning exceeded 45000ms". The
// evidence that answered it lives in three places, and gathering it by hand is
// the slow part: the run record (Cloud API), the sandbox (Daytona: is anything
// still executing, is a mount daemon wedged, what does the run's own journal
// say), and the edge (Cloudflare: what the Workers logged for that run id).
//
// Read-only by construction: the shell steps run list/inspect/tail commands and
// the agents are told to change nothing. It ends `needs_human` with a verdict
// file, never by "fixing" production.
//
//   flows run workflows/stuck-run-triage.flow.ts --local-agent \
//     --input '{"runIds":["c649fe14","8d864d39"],"listenerId":"28a6d9ec-…"}'
//
// Runs locally: it needs `wrangler` and `daytona` authenticated as you, plus
// ~/.agentworkforce/relay/cloud-auth.json for the Cloud API. A hosted run would
// need those credentials in the sandbox, which Cloud does not bundle today.

import { flow } from "@relayflows/surface";

const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const CLI = "claude";
const OUT = "triage";

export interface StuckRunTriageInput {
  /** Run ids (full or 8-char prefix) that are stuck. */
  runIds: string[];
  /** Optional: the listener that launched them, for context. */
  listenerId?: string;
  /** Cloud base URL; defaults to production. */
  apiUrl?: string;
}

export default flow<StuckRunTriageInput>(
  "stuck-run-triage",
  { budget: { dollars: 8, wallclock: "45m" } },
  async (f, input) => {
    const runIds = (input.runIds ?? []).filter((id) => /^[0-9a-f-]{8,36}$/u.test(id));
    if (runIds.length === 0) throw new Error("stuck-run-triage needs runIds (8-char prefixes or full ids)");
    const api = input.apiUrl ?? "https://agentrelay.com/cloud";

    await f.run(`rm -rf ${OUT} && mkdir -p ${OUT}`);

    // The three evidence-gathering steps are deterministic and journaled, so a
    // re-run replays them instead of re-hitting production.
    await f.run(
      `token=$(jq -r .accessToken "$HOME/.agentworkforce/relay/cloud-auth.json") && `
        + `for id in ${runIds.map(shellWord).join(" ")}; do `
        + `curl -sf -H "Authorization: Bearer $token" ${shellWord(`${api}/api/v1/workflows/runs/`)}"$id" `
        + `> ${OUT}/run-"$id".json || echo "run $id: not readable" >> ${OUT}/errors.txt; done; `
        + `ls -la ${OUT}`,
      { timeout: "2m" },
    );

    await f.run(
      `{ daytona sandbox list 2>&1 | head -80; } > ${OUT}/daytona-sandboxes.txt; `
        + `for f in ${OUT}/run-*.json; do sid=$(jq -r '.sandboxId // empty' "$f"); [ -n "$sid" ] || continue; `
        + `{ echo "=== $sid"; daytona sandbox info "$sid" 2>&1 | head -40; } >> ${OUT}/daytona-info.txt; done; `
        + `wc -l ${OUT}/daytona-*.txt`,
      { timeout: "5m" },
    );

    await f.run(
      `{ wrangler deployments list 2>&1 | head -30; echo; wrangler queues list 2>&1 | head -30; } `
        + `> ${OUT}/cloudflare.txt 2>&1; `
        + `for id in ${runIds.map(shellWord).join(" ")}; do `
        + `{ echo "=== tail for $id"; timeout 90 wrangler tail --format json --search "$id" 2>&1 | head -60; } `
        + `>> ${OUT}/cloudflare.txt; done; wc -l ${OUT}/cloudflare.txt`,
      { timeout: "10m" },
    );

    const context =
      `Evidence is in ./${OUT}: run-<id>.json (Cloud run records), daytona-sandboxes.txt, ` +
      `daytona-info.txt, cloudflare.txt. Runs under investigation: ${runIds.join(", ")}` +
      (input.listenerId ? `; listener ${input.listenerId}` : "") +
      `. You may run further READ-ONLY commands: daytona (list/info/exec with read-only commands such as ` +
      `ps, cat, ls, tail), wrangler (tail/deployments/queues), curl against the Cloud API with the token ` +
      `in ~/.agentworkforce/relay/cloud-auth.json. Change nothing: no restarts, no kills, no deletes, no ` +
      `deploys, no writes to any production surface. Never print a token or secret.`;

    await Promise.all([
      f.agent("sandbox-forensics", {
        cli: CLI,
        task:
          `${context}\n\nFor each run, find its sandbox and establish what is actually happening inside: ` +
          `is any process still doing work (relayflowd, flows, the agent CLI), what does the run's own ` +
          `journal under /home/daytona/.relayflow-v2-supervisor say about the last step and attempt, is a ` +
          `relayfile mount daemon wedged (look for 'notify flush', SIGUSR1 ack timeouts, --once exit 1), ` +
          `and when did anything last make progress. Quote the commands you ran and their output. Write ` +
          `${OUT}/sandbox-forensics.md: per run, a one-line verdict (working / wedged-on-X / dead) with ` +
          `the evidence under it.`,
      }),
      f.agent("edge-forensics", {
        cli: CLI,
        task:
          `${context}\n\nEstablish what Cloud and the edge think. For each run: status, timestamps, ` +
          `sandboxId, authority, and whether a terminal callback could still arrive. Then look for the ` +
          `failure mode in the Workers' logs — especially anything about relayfile ACL provisioning, ` +
          `revocation, queue depth, or Durable Object overload — and say whether a lease or timeout ` +
          `exists that will eventually end these runs, or whether they are immortal. Quote commands and ` +
          `output. Write ${OUT}/edge-forensics.md.`,
      }),
    ]);
    await f.run(`test -s ${OUT}/sandbox-forensics.md && test -s ${OUT}/edge-forensics.md`);

    await f.agent("verdict", {
      cli: CLI,
      task:
        `Read ${OUT}/sandbox-forensics.md and ${OUT}/edge-forensics.md. Write ${OUT}/verdict.md: the root ` +
        `cause (or the two or three candidates and the single observation that would separate them), ` +
        `whether these runs will ever terminate on their own, what recovery would take (and what it would ` +
        `cost — lost work, duplicate PRs), and the code-level defects worth a PR with file:line in the ` +
        `flows, cloud or relayfile-cloud repos. Where the two reports disagree, resolve it or list it ` +
        `under Unresolved with both positions. Recommend nothing you have not evidenced.`,
    });
    await f.run(`test -s ${OUT}/verdict.md && cat ${OUT}/verdict.md`);

    // A triage flow does not repair production: a human decides.
    f.done("needs_human");
  },
);
