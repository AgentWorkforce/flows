// task-graph — one big engineering task, split into subtasks that run in
// parallel wherever their dependencies allow.
//
// A task (a Linear ticket, or plain text) becomes a plan: subtasks with
// `dependsOn` edges, either supplied as input or written by a planner agent.
// Each subtask starts the moment every subtask it depends on has MERGED, runs
// in its own git worktree on its own branch, and merges back into the run's
// branch when it is done. A subtask may spawn follow-up subtasks, which join the
// graph while it runs. When the graph drains, the full test suite runs once
// against the integrated result.
//
// Run it on Cloud against the current checkout (see README.md):
//   flows run --cloud --sync-code --wait task-graph.flow.ts --input plan.json
//   flows sync <run-id>
// Or deploy it so every ticket in a Linear team gets planned and run:
//   flows deploy task-graph.flow.ts --repo acme/api --on linear:team=ENG --approver you
import { flow } from "@relayflows/surface";

type Subtask = { id: string; title: string; detail?: string; dependsOn?: string[] };
type Task = { title: string; body?: string; identifier?: string; url?: string };
type Input = {
  /** Plain task input for `flows run`. */
  task?: Task;
  /** A Linear/GitHub trigger delivers the ticket here instead. */
  issue?: Task;
  /** Skip the planner and run this graph as written. */
  plan?: { subtasks: Subtask[] };
  /** Subtasks running at once. Default 4. */
  maxParallel?: number;
};

const MAX_SUBTASKS = 20;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

// Task text is user input: it never reaches a shell unquoted.
const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const SUBTASK_SHAPE = `{"id":"kebab-case-id","title":"…","detail":"what done means","dependsOn":["other-id"]}`;
const PLAN_SHAPE = `{"subtasks":[${SUBTASK_SHAPE}, …]}`;

/** Returns an error message, or null when the subtasks form a valid DAG given `known` ids. */
function planError(subtasks: Subtask[], known: ReadonlySet<string>): string | null {
  const ids = new Set(known);
  for (const s of subtasks) {
    if (typeof s.id !== "string" || !ID.test(s.id)) return `bad subtask id ${JSON.stringify(s.id)}`;
    if (typeof s.title !== "string" || !s.title.trim()) return `subtask ${s.id} has no title`;
    if (ids.has(s.id)) return `duplicate subtask id ${s.id}`;
    ids.add(s.id);
  }
  for (const s of subtasks) {
    for (const d of s.dependsOn ?? []) if (!ids.has(d)) return `${s.id} depends on unknown ${d}`;
  }
  // Cycle check over the new subtasks; `known` ids are already scheduled, so they cannot close a cycle.
  const state = new Map<string, "visiting" | "done">();
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const visit = (id: string): boolean => {
    if (state.get(id) === "done" || !byId.has(id)) return true;
    if (state.get(id) === "visiting") return false;
    state.set(id, "visiting");
    const ok = (byId.get(id)?.dependsOn ?? []).every(visit);
    state.set(id, "done");
    return ok;
  };
  return subtasks.every((s) => visit(s.id)) ? null : "the plan has a dependency cycle";
}

// No `budget` header on purpose: today a budgeted authored flow admits one step
// at a time (sdk/src/authored-budget.ts), which would serialize the whole graph.
export default flow<Input>("task-graph", async (f, input) => {
  const task = input.task ?? input.issue;
  if (!task || typeof task.title !== "string" || !task.title.trim()) {
    await f.run("echo 'Stopped: no task or issue arrived with this run.' >&2");
    return f.done("needs_human");
  }
  const brief = `${task.title}\n\n${task.body ?? ""}${task.url ? `\n\n${task.url}` : ""}`;
  const maxParallel = Math.max(1, Math.min(8, input.maxParallel ?? 4));

  const root = (await f.run("pwd")).trim();
  const work = `${root}/.relayflow`;
  // Flow bookkeeping and worktrees live under an excluded dir so no merge or `git add -A` picks them up.
  await f.run(
    `rm -rf ${shellWord(work)} && git worktree prune && mkdir -p ${shellWord(`${work}/results`)} && ` +
      `{ grep -qxF '.relayflow/' .git/info/exclude 2>/dev/null || echo '.relayflow/' >> .git/info/exclude; }`,
  );

  // 1. The plan: given, or written by a planner agent.
  let subtasks = input.plan?.subtasks;
  if (!subtasks) {
    await f.agent("planner", {
      cli: "claude",
      task:
        `Read this repository, then split the task below into 3-${MAX_SUBTASKS / 2} subtasks that each ` +
        `fit one focused agent session. Make dependsOn honest: only list a dependency when the subtask ` +
        `really needs that code merged first — everything else runs in parallel. Do not write code.\n` +
        `Write ONLY this JSON to ${work}/plan.json:\n${PLAN_SHAPE}\n\nTask:\n${brief}`,
    }).gate({ type: "subprocess_gate", command: `node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' ${shellWord(`${work}/plan.json`)}` });
    subtasks = (JSON.parse(await f.run(`cat ${shellWord(`${work}/plan.json`)}`)) as { subtasks: Subtask[] }).subtasks;
  }
  const invalid = Array.isArray(subtasks) ? planError(subtasks, new Set()) : "plan.subtasks is not a list";
  if (invalid || subtasks.length > MAX_SUBTASKS) {
    await f.run(`echo ${shellWord(`Stopped: ${invalid ?? `more than ${MAX_SUBTASKS} subtasks`}.`)} >&2`);
    return f.done("needs_human");
  }

  // 2. The scheduler. `merged` holds one promise per subtask that resolves once its branch is merged.
  const merged = new Map<string, Promise<void>>();
  const all: Subtask[] = [];
  const summaries: string[] = [];
  let running = 0;
  const slotWaiters: Array<() => void> = [];
  const acquireSlot = async (): Promise<void> => {
    if (running < maxParallel) { running++; return; }
    await new Promise<void>((resolve) => slotWaiters.push(resolve));
  };
  const releaseSlot = (): void => {
    const next = slotWaiters.shift();
    if (next) next(); else running--;
  };
  // Worktree creation and merges touch the run's branch, so they take turns.
  let gitTail: Promise<unknown> = Promise.resolve();
  const onRunBranch = <T>(op: () => PromiseLike<T>): Promise<T> => {
    const result = gitTail.then(op);
    gitTail = result.catch(() => undefined);
    return result;
  };

  const runSubtask = async (s: Subtask, parent?: string): Promise<void> => {
    await Promise.all((s.dependsOn ?? []).map((d) => merged.get(d)));
    if (parent) await merged.get(parent);
    await acquireSlot();
    try {
      const tree = `${work}/wt/${s.id}`;
      const branch = `task-graph/${s.id}`;
      // Branched from the run's branch as it is NOW, so every dependency's code is already in it.
      const base = (await onRunBranch(() => f.run(
        `git worktree add -q -B ${shellWord(branch)} ${shellWord(tree)} HEAD && git rev-parse HEAD`,
      ))).trim();
      const result = `${work}/results/${s.id}.json`;
      const others = all.filter((o) => o.id !== s.id).map((o) => `- ${o.id}: ${o.title}`).join("\n");
      await f.agent(s.id, {
        cli: "claude",
        // Not `cwd: tree`: the kernel refuses that field today (unknown field "cwd"), so the path is in the task.
        task:
          `You are one subtask of a larger task. Your git worktree is ${tree} (branch ${branch}): ` +
          `cd into it first, and read, edit, test and commit ONLY inside it — never in ${root}.\n` +
          `Overall task:\n${brief}\n\nYOUR subtask (${s.id}): ${s.title}\n${s.detail ?? ""}\n\n` +
          `Other subtasks are handled by other agents in parallel — stay inside yours:\n${others}\n\n` +
          `Implement it with tests, run the relevant tests, and commit everything on ${branch}. ` +
          `If you discover necessary work outside your scope, do not do it: list it as a follow-up.\n` +
          `Finally write ${result} as JSON: {"summary":"what you did","followups":[${SUBTASK_SHAPE}, …]} ` +
          `(followups may be empty; their ids must be new).`,
      // Done means a result file AND at least one commit on the branch — not the agent saying so.
      }).gate({ type: "subprocess_gate", command: `test -s ${shellWord(result)} && test "$(git -C ${shellWord(tree)} rev-list --count ${base}..HEAD)" -gt 0` });

      // 3. Merge back. A conflict goes to an agent that must leave the branch merged.
      const outcome = (await onRunBranch(() => f.run(
        `git merge --no-ff -q -m ${shellWord(`task-graph: merge ${s.id}`)} ${shellWord(branch)} >/dev/null 2>&1 && echo merged || { git merge --abort; echo conflict; }`,
      ))).trim();
      if (outcome !== "merged") {
        await onRunBranch(() => f.agent(`${s.id}-merge`, {
          cli: "claude",
          task: `Merge branch ${branch} into the current branch and resolve every conflict so both sides' intent survives. ` +
            `Run the affected tests, then commit the merge.`,
        }).gate({ type: "subprocess_gate", command: `git merge-base --is-ancestor ${shellWord(branch)} HEAD` }));
      }
      await f.run(`git worktree remove --force ${shellWord(tree)}`);

      // 4. Follow-ups join the graph. They run after this subtask, plus whatever they declare.
      const report = JSON.parse(await f.run(`cat ${shellWord(result)}`)) as { summary?: string; followups?: Subtask[] };
      summaries.push(`- **${s.id}** — ${report.summary ?? s.title}`);
      const followups = Array.isArray(report.followups) ? report.followups : [];
      const rejected = followups.length > MAX_SUBTASKS - all.length
        ? `would exceed ${MAX_SUBTASKS} subtasks`
        : planError(followups, new Set(merged.keys()));
      if (followups.length > 0 && rejected) {
        await f.run(`echo ${shellWord(`Follow-ups from ${s.id} not scheduled: ${rejected}.`)} >&2`);
      } else {
        for (const child of followups) schedule(child, s.id);
      }
    } finally {
      releaseSlot();
    }
  };

  const schedule = (s: Subtask, parent?: string): void => {
    all.push(s);
    merged.set(s.id, runSubtask(s, parent));
  };
  for (const s of subtasks) all.push(s);
  for (const s of subtasks) merged.set(s.id, runSubtask(s));

  // Follow-ups can be added while we wait, so drain until the set stops growing.
  for (let seen = 0; seen < merged.size;) {
    seen = merged.size;
    await Promise.all(merged.values());
  }

  // 5. The whole graph is merged: one integrated test run, outside any agent.
  await f.run(
    'if [ -f package.json ] && node -e \'p=require("./package.json");process.exit(p.scripts&&p.scripts.test?0:1)\'; ' +
      'then npm ci --no-audit --no-fund && npm test; else echo "no test script; skipping"; fi',
    { timeout: "15m" },
  );

  // Triggered from a ticket: open one PR for the whole graph. A `flows run` leaves it to `flows sync`.
  if (input.issue) {
    const body = `${task.url ? `Ticket: ${task.url}\n\n` : ""}Subtasks, each merged from its own branch:\n\n${summaries.join("\n")}\n`;
    await f.run(`printf '%s' ${shellWord(body)} > ${shellWord(`${work}/pr-body.md`)}`);
    await f.run("git push --set-upstream origin HEAD", { timeout: "2m" });
    await f.run(`gh pr create --title ${shellWord(task.title.trim().slice(0, 240))} --body-file ${shellWord(`${work}/pr-body.md`)}`, { timeout: "2m" });
  }
  f.done("success");
});
