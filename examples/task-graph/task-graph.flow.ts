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
  /** Follow-up subtasks agents may add mid-run. Default 3; 0 turns them off. */
  maxFollowups?: number;
  /** Command that tests the integrated result. Default: `npm ci && npm test` when package.json has a test script. */
  testCommand?: string;
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
  let followupBudget = Math.max(0, Math.min(10, input.maxFollowups ?? 3));

  const root = (await f.run("pwd")).trim();
  const work = `${root}/.relayflow`;
  // Subtask branches live under a namespace for this base commit, so they never reuse a branch the repo
  // already has. A rerun from the same commit clears only this namespace, which only this flow writes.
  const branchPrefix = `task-graph/${(await f.run("git rev-parse --short=10 HEAD")).trim()}`;
  // Flow bookkeeping and worktrees live under an excluded dir so no merge or `git add -A` picks them up.
  await f.run(
    `rm -rf ${shellWord(work)} && git worktree prune && mkdir -p ${shellWord(`${work}/results`)} && ` +
      // --git-path, not .git/info/exclude: in a linked worktree .git is a file, not a directory.
      `exclude="$(git rev-parse --git-path info/exclude)" && mkdir -p "$(dirname "$exclude")" && ` +
      `{ grep -qxF '.relayflow/' "$exclude" 2>/dev/null || echo '.relayflow/' >> "$exclude"; } && ` +
      `git for-each-ref --format='%(refname:short)' ${shellWord(`refs/heads/${branchPrefix}/`)} | ` +
      `while read -r b; do git branch -D -q "$b"; done`,
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
    // The planner must only plan: a parseable plan AND an untouched working tree (.relayflow/ is excluded).
    }).gate({
      type: "subprocess_gate",
      command: `node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' ${shellWord(`${work}/plan.json`)} && ` +
        `test -z "$(git status --porcelain)"`,
    });
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
    // Yield before reading dependencies: the scheduling loop registers every subtask first, so a plan
    // need not list dependencies before dependents (a Linear-built plan does not).
    await Promise.resolve();
    const deps = [...(s.dependsOn ?? []), ...(parent === undefined ? [] : [parent])].map((d) => merged.get(d));
    if (deps.some((d) => d === undefined)) throw new Error(`subtask ${s.id} depends on a subtask that was never scheduled`);
    await Promise.all(deps);
    await acquireSlot();
    try {
      const tree = `${work}/wt/${s.id}`;
      const branch = `${branchPrefix}/${s.id}`;
      // Branched from the run's branch as it is NOW, so every dependency's code is already in it.
      const base = (await onRunBranch(() => f.run(
        `git worktree add -q -b ${shellWord(branch)} ${shellWord(tree)} HEAD && git rev-parse HEAD`,
      ))).trim();
      const result = `${work}/results/${s.id}.json`;
      const others = all.filter((o) => o.id !== s.id).map((o) => `- ${o.id}: ${o.title}`).join("\n");
      // Only planned subtasks may propose follow-ups, and only work the task cannot ship without:
      // left open, agents file polish and docs follow-ups that spawn more of the same.
      const mayPropose = parent === undefined && followupBudget > 0;
      await f.agent(s.id, {
        cli: "claude",
        cwd: tree,
        task:
          `You are one subtask of a larger task, working in your own git worktree (${tree}, branch ${branch}). ` +
          `Read, edit, test and commit only inside it.\n` +
          `Overall task:\n${brief}\n\nYOUR subtask (${s.id}): ${s.title}\n${s.detail ?? ""}\n\n` +
          `Other subtasks are handled by other agents in parallel — stay inside yours:\n${others}\n\n` +
          `Implement it with tests, run the relevant tests, and commit everything on ${branch}. Do not do work outside your scope.\n` +
          (mayPropose
            ? `If you found work the overall task CANNOT ship without and no subtask above covers, list it as a follow-up ` +
              `(at most 2; never polish, docs, refactors or nice-to-haves — most subtasks have none).\n` +
              `Finally write ${result} as JSON: {"summary":"what you did","followups":[${SUBTASK_SHAPE}]} ` +
              `(followups is usually empty; ids must be new).`
            : `Finally write ${result} as JSON: {"summary":"what you did"}.`),
      // Done means a parseable result file AND at least one commit on the branch — not the agent saying so.
      }).gate({
        type: "subprocess_gate",
        command: `node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' ${shellWord(result)} && ` +
          `test "$(git -C ${shellWord(tree)} rev-list --count ${base}..HEAD)" -gt 0`,
      });

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
      await onRunBranch(() => f.run(`git worktree remove --force ${shellWord(tree)}`));

      // 4. Follow-ups join the graph. They run after this subtask, plus whatever they declare.
      const report = JSON.parse(await f.run(`cat ${shellWord(result)}`)) as { summary?: string; followups?: Subtask[] };
      summaries.push(`- **${s.id}** — ${report.summary ?? s.title}`);
      const proposed = mayPropose && Array.isArray(report.followups) ? report.followups : [];
      // The budget is claimed synchronously, so two subtasks finishing together cannot both spend it.
      const followups = proposed.slice(0, Math.min(followupBudget, MAX_SUBTASKS - all.length));
      const invalid = planError(followups, new Set(merged.keys()));
      if (invalid === null) {
        followupBudget -= followups.length;
        for (const child of followups) schedule(child, s.id);
      }
      const dropped = invalid ?? (followups.length < proposed.length
        ? `${proposed.length - followups.length} over the follow-up budget` : null);
      if (dropped) await f.run(`echo ${shellWord(`Follow-ups from ${s.id} not scheduled: ${dropped}.`)} >&2`);
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

  // 5. The whole graph is merged: one integrated test run, outside any agent. No test command is a stop,
  // never a silent pass — the merged work is still on the run's branch for a human to test.
  const hasNpmTest = (await f.run(
    'if [ -f package.json ] && node -e \'p=require("./package.json");process.exit(p.scripts&&p.scripts.test?0:1)\'; then echo yes; else echo no; fi',
  )).trim() === "yes";
  const testCommand = input.testCommand ?? (hasNpmTest ? "npm ci --no-audit --no-fund && npm test" : undefined);
  if (testCommand === undefined) {
    await f.run("echo 'Stopped before testing: no npm test script. Pass testCommand for this repository.' >&2");
    return f.done("needs_human");
  }
  await f.run(testCommand, { timeout: "15m" });

  // Triggered from a ticket: open one PR for the whole graph. A `flows run` leaves it to `flows sync`.
  if (input.issue) {
    const body = `${task.url ? `Ticket: ${task.url}\n\n` : ""}Subtasks, each merged from its own branch:\n\n${summaries.join("\n")}\n`;
    await f.run(`printf '%s' ${shellWord(body)} > ${shellWord(`${work}/pr-body.md`)}`);
    await f.run("git push --set-upstream origin HEAD", { timeout: "2m" });
    await f.run(`gh pr create --title ${shellWord(task.title.trim().slice(0, 240))} --body-file ${shellWord(`${work}/pr-body.md`)}`, { timeout: "2m" });
  }
  f.done("success");
});
