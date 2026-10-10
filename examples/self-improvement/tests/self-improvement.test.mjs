import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { digestRuns } from "../digest.mjs";
import { diffSpecs } from "../spec-diff.mjs";

const here = fileURLToPath(new URL("..", import.meta.url));
const fixture = join(here, "example", "runs.fixture.json");
const scratch = () => mkdtempSync(join(tmpdir(), "self-improvement-"));
const node = (args) => spawnSync(process.execPath, args, { cwd: here, encoding: "utf8" });

const step = (name, extra = {}) => ({ step_name: name, step_type: "agent", status: "completed", completion_reason: "success",
  duration_ms: 1000, cost_usd: 0.1, retry_count: 0, attempts: [], gate: null, transcript: null, ...extra });

test("a step that fails a third of its runs outranks the step holding most of the spend", () => {
  const { runs } = JSON.parse(readFileSync(fixture, "utf8"));
  const digest = digestRuns(runs.filter((r) => r.name === "issue-triage" && r.status !== "cancelled"));
  assert.equal(digest.runs, 6);
  assert.equal(digest.steps[0].step, "classify");
  assert.equal(digest.steps[0].primary_signal, "failing");
  assert.deepEqual(digest.steps[0].failed_runs, ["run-2026-10-07-b", "run-2026-10-04-e"]);
  assert.equal(digest.steps[1].step, "draft-reply");
  assert.equal(digest.steps[1].primary_signal, "costly");
});

test("skipped steps are not executions, and a retried success counts as weak", () => {
  const digest = digestRuns([
    { run_id: "r1", steps: [step("a", { retry_count: 1 }), step("b", { status: "skipped", completion_reason: null })] },
    { run_id: "r2", steps: [step("a"), step("b")] },
  ]);
  const a = digest.steps.find((s) => s.step === "a");
  const b = digest.steps.find((s) => s.step === "b");
  assert.equal(a.weak, 1);
  assert.deepEqual(a.weak_runs, ["r1"]);
  assert.equal(b.executions, 1);
});

test("collect-runs keeps only the named flow's terminal runs", () => {
  const out = scratch();
  const result = node(["collect-runs.mjs", "--flow", "issue-triage", "--fixture", fixture, "--out", out]);
  assert.equal(result.status, 0, result.stderr);
  const ids = JSON.parse(readFileSync(join(out, "runs.json"), "utf8")).runs.map((r) => r.run_id);
  assert.equal(ids.length, 6);
  assert.ok(!ids.includes("run-2026-10-08-x"), "cancelled run collected");
  assert.ok(!ids.includes("run-2026-10-08-y"), "another flow's run collected");
});

test("collect-runs fails closed when the flow has no terminal runs", () => {
  const result = node(["collect-runs.mjs", "--flow", "nope", "--fixture", fixture, "--out", scratch()]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no completed or failed runs/);
});

const spec = (steps, extra = {}) => ({ name: "t", description: "d", steps, ...extra });
const agent = (id, instruction, extra = {}) => ({ id, type: "agent", instruction, depends_on: [], max_iterations: 1, ...extra });

test("spec-diff separates prompt edits from structural ones and ignores labels", () => {
  const before = spec([agent("a", "old")]);
  assert.deepEqual(diffSpecs(before, spec([agent("a", "new")], { description: "x" })), { prompt: [{ step: "a", field: "instruction" }], structure: [] });
  const after = spec([agent("a", "old", { max_iterations: 2 }), { id: "check", type: "deterministic", command: "true", depends_on: ["a"] }]);
  assert.deepEqual(diffSpecs(before, after), { prompt: [], structure: ["step a: max_iterations changed", "step check added (deterministic)"] });
  assert.deepEqual(diffSpecs(before, spec([])).structure, ["step a removed"]);
});

function proposalDir() {
  const dir = scratch();
  assert.equal(node(["collect-runs.mjs", "--flow", "issue-triage", "--fixture", fixture, "--out", dir]).status, 0);
  const proposal = {
    target_step: "classify", signal: "failing", diagnosis: "The instruction never asks for the LABEL: line.",
    evidence: [{ run_id: "run-2026-10-07-b", observation: "Prose classification, no LABEL: line." }],
    prompt_edits: [{ step: "classify", change: "End with exactly one line LABEL: <bug|feature|question|docs>.", rationale: "The gate checks for it." }],
    structure_edits: [{ change: "classify.maxIterations: 2", rationale: "One repair pass on a gate miss." }],
    hypothesis: { before: "2/6 runs fail at classify", after: "0/6", metric: "classify failure rate", expected: "below 5%", falsified_if: "any verification_failed at classify in the next 10 runs" },
  };
  writeFileSync(join(dir, "proposal.json"), JSON.stringify(proposal));
  writeFileSync(join(dir, "before.json"), JSON.stringify(spec([agent("fetch", "x"), agent("classify", "old")])));
  return { dir, proposal };
}

test("check-proposal refuses a proposal that cites an uncollected run or an unknown step", () => {
  const { dir, proposal } = proposalDir();
  const ok = node(["check-proposal.mjs", "proposal", "--dir", dir, "--spec", join(dir, "before.json")]);
  assert.equal(ok.status, 0, ok.stderr);
  writeFileSync(join(dir, "proposal.json"), JSON.stringify({ ...proposal, target_step: "ghost", evidence: [{ run_id: "made-up", observation: "x" }] }));
  const bad = node(["check-proposal.mjs", "proposal", "--dir", dir, "--spec", join(dir, "before.json")]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /target_step "ghost"/);
  assert.match(bad.stderr, /run "made-up", which was not collected/);
});

test("check-proposal edit needs both a prompt and a structural change, in the flow file only", () => {
  const { dir } = proposalDir();
  const flowPath = "flows/t.flow.yaml";
  const run = (after, changed) => {
    writeFileSync(join(dir, "after.json"), JSON.stringify(after));
    writeFileSync(join(dir, "changed.txt"), changed.join("\n"));
    return node(["check-proposal.mjs", "edit", "--dir", dir, "--flow-path", flowPath, "--changed", join(dir, "changed.txt"),
      "--before", join(dir, "before.json"), "--after", join(dir, "after.json")]);
  };
  const promptOnly = run(spec([agent("fetch", "x"), agent("classify", "new")]), [flowPath]);
  assert.equal(promptOnly.status, 1);
  assert.match(promptOnly.stderr, /no structural change/);
  const both = spec([agent("fetch", "x"), agent("classify", "new", { max_iterations: 2 })]);
  const strayFile = run(both, [flowPath, "README.md"]);
  assert.equal(strayFile.status, 1);
  assert.match(strayFile.stderr, /must change exactly/);
  const good = run(both, [flowPath]);
  assert.equal(good.status, 0, good.stderr);
  const body = readFileSync(join(dir, "pr-body.md"), "utf8");
  assert.match(body, /\*\*Before:\*\* 2\/6 runs fail at classify/);
  assert.match(body, /structure: step classify: max_iterations changed/);
});
