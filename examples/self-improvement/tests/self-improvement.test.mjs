import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { digestRuns } from "../digest.mjs";
import { coverage, diffSpecs } from "../spec-diff.mjs";

const here = fileURLToPath(new URL("..", import.meta.url));
const fixture = join(here, "example", "runs.fixture.json");
const scratch = () => mkdtempSync(join(tmpdir(), "self-improvement-"));
const node = (args) => spawnSync(process.execPath, args, { cwd: here, encoding: "utf8" });

const step = (name, extra = {}) => ({ step_name: name, step_type: "agent", status: "completed", completion_reason: "success",
  duration_ms: 1000, cost_usd: 0.1, retry_count: 0, attempts: [], gate: null, transcript: null, ...extra });
const spec = (steps, extra = {}) => ({ name: "t", description: "d", steps, ...extra });
const agent = (id, instruction, extra = {}) => ({ id, type: "agent", instruction, depends_on: [], max_iterations: 1, ...extra });
/** What compile-spec.mjs records: every step id except those the compiler generated. */
const authoredOf = (before, after, generated = []) => ({
  before: new Set(before.steps.map((s) => s.id).filter((id) => !generated.includes(id))),
  after: new Set(after.steps.map((s) => s.id).filter((id) => !generated.includes(id))),
});

/** The example target's step ids, as its compiled spec names them. */
function targetSpec() {
  const path = join(scratch(), "spec.json");
  writeFileSync(path, JSON.stringify(spec(["fetch", "classify", "draft-reply", "record"].map((id) => agent(id, id)))));
  return path;
}
const collect = (out, flow = "issue-triage", extra = []) =>
  node(["collect-runs.mjs", "--flow", flow, "--spec", targetSpec(), "--fixture", fixture, "--out", out, ...extra]);

test("a step that fails a third of its runs outranks the step holding most of the spend", () => {
  const { runs } = JSON.parse(readFileSync(fixture, "utf8"));
  const ours = runs.filter((r) => r.name === "issue-triage" && r.status !== "cancelled" && r.run_id !== "run-2026-10-08-z");
  const digest = digestRuns(ours);
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

test("collect-runs keeps only this flow's terminal runs, dropping a same-named foreign flow", () => {
  const out = scratch();
  const result = collect(out);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(readFileSync(join(out, "runs.json"), "utf8"));
  const ids = body.runs.map((r) => r.run_id);
  assert.equal(ids.length, 6);
  assert.equal(body.dropped_foreign, 1);
  for (const skipped of ["run-2026-10-08-x", "run-2026-10-08-y", "run-2026-10-08-z"]) assert.ok(!ids.includes(skipped), skipped);
});

test("foreign runs do not count toward --runs", () => {
  const out = scratch();
  assert.equal(collect(out, "issue-triage", ["--runs", "2", "--scan", "5"]).status, 0);
  const ids = JSON.parse(readFileSync(join(out, "runs.json"), "utf8")).runs.map((r) => r.run_id);
  assert.deepEqual(ids, ["run-2026-10-08-a", "run-2026-10-07-b"]);
});

test("collect-runs fails closed when the flow has no terminal runs", () => {
  const result = collect(scratch(), "nope");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no completed or failed runs/);
});

test("spec-diff separates prompt edits from structural ones and ignores labels and dependency order", () => {
  const before = spec([agent("a", "old")]);
  assert.deepEqual(diffSpecs(before, spec([agent("a", "new")], { description: "x" })), { prompt: [{ step: "a", field: "instruction" }], structure: [] });
  const after = spec([agent("a", "old", { max_iterations: 2 }), { id: "check", type: "deterministic", command: "true", depends_on: ["a"] }]);
  assert.deepEqual(diffSpecs(before, after).structure.map((s) => [s.step, s.field]), [["a", "max_iterations"], ["check", "added"]]);
  assert.deepEqual(diffSpecs(before, spec([])).structure, [{ step: "a", field: "removed" }]);
  const ab = spec([agent("x", "i", { depends_on: ["a", "b"] })]);
  assert.deepEqual(diffSpecs(ab, spec([agent("x", "i", { depends_on: ["b", "a"] })])).structure, []);
});

test("coverage accepts exactly the proposal, including the steps the compiler derives from it", () => {
  const before = spec([agent("classify", "old"), agent("reply", "r", { depends_on: ["classify"] })]);
  const after = spec([
    agent("classify", "new", { verification: { regex: "x" } }),
    { id: "classify.gate", type: "deterministic", command: "node", depends_on: ["classify"], input: { output: { step: "classify" } } },
    agent("reply", "r", { depends_on: ["classify.gate"] }),
  ]);
  const proposal = { target_step: "classify", prompt_edits: [{ step: "classify", new_text: "new" }],
    structure_edits: [{ step: "classify", field: "verification" }] };
  const check = (spec2, p = proposal) => coverage(diffSpecs(before, spec2), p, spec2, before, authoredOf(before, spec2, ["classify.gate"])).join("\n");
  assert.equal(check(after), "");
  const stray = spec([...after.steps.slice(0, 2), agent("reply", "rewritten", { depends_on: ["classify.gate"] })]);
  assert.match(check(stray), /step reply: instruction changed, but the proposal has no prompt edit/);
  assert.match(check(after, { ...proposal, structure_edits: [{ step: "classify", field: "verification" }, { step: "flow", field: "budget" }] }),
    /proposed structure edit flow.budget is not in the compiled flow/);
});

test("coverage compares fields and prompt text, not just step ids", () => {
  const before = spec([agent("classify", "old")]);
  const after = spec([agent("classify", "new", { timeout_ms: 5000 })]);
  const proposal = { target_step: "classify", prompt_edits: [{ step: "classify", new_text: "new" }],
    structure_edits: [{ step: "classify", field: "max_iterations" }] };
  const problems = coverage(diffSpecs(before, after), proposal, after, before, authoredOf(before, after)).join("\n");
  assert.match(problems, /step classify: timeout_ms changed, but no structure edit proposes classify.timeout_ms/);
  assert.match(problems, /proposed structure edit classify.max_iterations is not in the compiled flow/);
  const otherText = { ...proposal, prompt_edits: [{ step: "classify", new_text: "something else" }] };
  assert.match(coverage(diffSpecs(before, after), otherText, after, before, authoredOf(before, after)).join("\n"), /compiled prompt is not the proposed new_text/);
});

test("a prompt edit on a step the proposal adds is checked like any other", () => {
  const before = spec([agent("a", "x")]);
  const after = spec([agent("a", "y"), agent("verify", "check a", { depends_on: ["a"] })]);
  const proposal = { target_step: "a", prompt_edits: [{ step: "a", new_text: "y" }, { step: "verify", new_text: "check a" }],
    structure_edits: [{ step: "verify", field: "added" }] };
  assert.deepEqual(coverage(diffSpecs(before, after), proposal, after, before, authoredOf(before, after)), []);
  const missing = { ...proposal, prompt_edits: [{ step: "a", new_text: "y" }] };
  assert.match(coverage(diffSpecs(before, after), missing, after, before, authoredOf(before, after)).join("\n"), /step verify: instruction changed, but the proposal has no prompt edit/);
});

test("only <step>.gate is compiler-derived, and only for a verification or added edit", () => {
  const before = spec([agent("classify", "old"), agent("classify.audit", "a", { depends_on: ["classify"] })]);
  const after = spec([agent("classify", "new", { max_iterations: 2 }), agent("classify.audit", "a", { depends_on: ["classify"], timeout_ms: 9 })]);
  const proposal = { target_step: "classify", prompt_edits: [{ step: "classify", new_text: "new" }],
    structure_edits: [{ step: "classify", field: "max_iterations" }] };
  assert.match(coverage(diffSpecs(before, after), proposal, after, before, authoredOf(before, after)).join("\n"), /classify.audit: timeout_ms changed, but no structure edit proposes/);
});

test("depends_on rewiring is exempt only around an inserted or removed step", () => {
  const before = spec([agent("classify", "old"), agent("reply", "r", { depends_on: [] })]);
  const after = spec([agent("classify", "new", { max_iterations: 2 }), agent("reply", "r", { depends_on: ["classify"] })]);
  const proposal = { target_step: "classify", prompt_edits: [{ step: "classify", new_text: "new" }],
    structure_edits: [{ step: "classify", field: "max_iterations" }] };
  assert.match(coverage(diffSpecs(before, after), proposal, after, before, authoredOf(before, after)).join("\n"), /step reply: depends_on changed, but no structure edit proposes reply.depends_on/);
});

function proposalDir() {
  const dir = scratch();
  assert.equal(collect(dir).status, 0);
  const proposal = {
    target_step: "classify", signal: "failing", diagnosis: "The instruction never asks for the LABEL: line.",
    evidence: [{ run_id: "run-2026-10-07-b", observation: "Prose classification, no LABEL: line." }],
    prompt_edits: [{ step: "classify", new_text: "new", rationale: "The gate checks for a LABEL: line." }],
    structure_edits: [{ step: "classify", field: "max_iterations", change: "classify.maxIterations: 2", rationale: "One repair pass on a gate miss." }],
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

test("check-proposal edit needs the proposal's prompt and structural changes, in the flow file only", () => {
  const { dir, proposal } = proposalDir();
  const flowPath = "flows/t.flow.yaml";
  const run = (after, changed) => {
    writeFileSync(join(dir, "after.json"), JSON.stringify(after));
    writeFileSync(join(dir, "changed.txt"), changed.join("\n"));
    writeFileSync(join(dir, "before.authored.json"), JSON.stringify(JSON.parse(readFileSync(join(dir, "before.json"), "utf8")).steps.map((s) => s.id)));
    writeFileSync(join(dir, "after.authored.json"), JSON.stringify(after.steps.map((s) => s.id)));
    return node(["check-proposal.mjs", "edit", "--dir", dir, "--flow-path", flowPath, "--changed", join(dir, "changed.txt"),
      "--before", join(dir, "before.json"), "--after", join(dir, "after.json"),
      "--before-authored", join(dir, "before.authored.json"), "--after-authored", join(dir, "after.authored.json")]);
  };
  const promptOnly = run(spec([agent("fetch", "x"), agent("classify", "new")]), [flowPath]);
  assert.equal(promptOnly.status, 1);
  assert.match(promptOnly.stderr, /no structural change/);
  const both = spec([agent("fetch", "x"), agent("classify", "new", { max_iterations: 2 })]);
  const strayFile = run(both, [flowPath, "README.md"]);
  assert.equal(strayFile.status, 1);
  assert.match(strayFile.stderr, /must change exactly/);
  const offProposal = run(spec([agent("fetch", "x", { max_iterations: 3 }), agent("classify", "new", { max_iterations: 2 })]), [flowPath]);
  assert.equal(offProposal.status, 1);
  assert.match(offProposal.stderr, /step fetch: max_iterations changed, but no structure edit proposes fetch.max_iterations/);
  // The proposal is re-validated at the edit stage: rewriting it after its own check fails here too.
  writeFileSync(join(dir, "proposal.json"), JSON.stringify({ ...proposal, evidence: [{ run_id: "made-up", observation: "x" }] }));
  assert.match(run(both, [flowPath]).stderr, /run "made-up", which was not collected/);
  writeFileSync(join(dir, "proposal.json"), JSON.stringify(proposal));
  const good = run(both, [flowPath]);
  assert.equal(good.status, 0, good.stderr);
  const body = readFileSync(join(dir, "pr-body.md"), "utf8");
  assert.match(body, /\*\*Before:\*\* 2\/6 runs fail at classify/);
  assert.match(body, /structure: step classify: max_iterations changed/);
});

test("seal verify refuses a file changed since it was sealed", () => {
  const dir = scratch();
  const file = join(dir, "runs.json");
  writeFileSync(file, "{}");
  const sealed = node(["seal.mjs", "seal", file]);
  assert.equal(sealed.status, 0, sealed.stderr);
  assert.equal(node(["seal.mjs", "verify", sealed.stdout.trim()]).status, 0);
  writeFileSync(file, '{"forged":true}');
  const tampered = node(["seal.mjs", "verify", sealed.stdout.trim()]);
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /changed since sealed/);
});

test("compile-spec refuses a flow path that is a symlink out of the checkout", () => {
  const dir = scratch();
  mkdirSync(join(dir, "target"));
  writeFileSync(join(dir, "outside.flow.yaml"), "name: x\n");
  symlinkSync(join(dir, "outside.flow.yaml"), join(dir, "target", "t.flow.yaml"));
  const result = node(["compile-spec.mjs", join(dir, "target"), join(dir, "target", "t.flow.yaml"), join(dir, "out.json")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside .*refusing/);
});

test("the flow embeds the current helpers", () => {
  const result = node(["bundle.mjs", "--check"]);
  assert.equal(result.status, 0, result.stderr);
});

test("check-proposal treats only field \"added\" as creating a step", () => {
  const { dir, proposal } = proposalDir();
  const run = (p) => {
    writeFileSync(join(dir, "proposal.json"), JSON.stringify(p));
    return node(["check-proposal.mjs", "proposal", "--dir", dir, "--spec", join(dir, "before.json")]);
  };
  const ghost = run({ ...proposal, prompt_edits: [...proposal.prompt_edits, { step: "ghost", new_text: "x", rationale: "r" }],
    structure_edits: [...proposal.structure_edits, { step: "ghost", field: "max_iterations", change: "c", rationale: "r" }] });
  assert.equal(ghost.status, 1);
  assert.match(ghost.stderr, /prompt edit names step "ghost", which neither exists nor is added/);
  assert.match(ghost.stderr, /structure edit ghost.max_iterations names a step the flow does not have/);
  const added = run({ ...proposal, prompt_edits: [...proposal.prompt_edits, { step: "verify", new_text: "x", rationale: "r" }],
    structure_edits: [...proposal.structure_edits, { step: "verify", field: "added", change: "c", rationale: "r" }] });
  assert.equal(added.status, 0, added.stderr);
});

test("prompt text must match exactly, bar the newline a YAML block scalar appends", () => {
  const before = spec([agent("a", "old")]);
  const proposal = { target_step: "a", prompt_edits: [{ step: "a", new_text: "new" }], structure_edits: [] };
  const problems = (text) => coverage(diffSpecs(before, spec([agent("a", text)])), proposal, spec([agent("a", text)]), before, authoredOf(before, spec([agent("a", text)]))).join("\n");
  assert.equal(problems("new\n"), "");
  assert.match(problems("  new"), /compiled prompt is not the proposed new_text/);
  assert.match(problems("new \n"), /compiled prompt is not the proposed new_text/);
});

test("an authored step is never exempt, even one that imitates a lowered gate exactly", () => {
  // The realistic custom gate: authored as classify.gate, bound to classify's output.
  const userGate = { id: "classify.gate", type: "deterministic", command: "printf user", depends_on: ["classify"], input: { output: { step: "classify" } } };
  const before = spec([agent("classify", "old"), userGate]);
  const lowered = { id: "classify.gate.gate", type: "deterministic", command: "node", depends_on: ["classify"], input: { output: { step: "classify" } } };
  const after = spec([agent("classify", "new", { verification: { json_schema: true } }), lowered,
    { ...userGate, command: "printf tampered", depends_on: ["classify", "classify.gate.gate"] }]);
  const proposal = { target_step: "classify", prompt_edits: [{ step: "classify", new_text: "new" }],
    structure_edits: [{ step: "classify", field: "verification" }] };
  const problems = coverage(diffSpecs(before, after), proposal, after, before, authoredOf(before, after, ["classify.gate.gate"])).join("\n");
  assert.match(problems, /step classify.gate: command changed, but no structure edit proposes classify.gate.command/);
  assert.doesNotMatch(problems, /classify\.gate\.gate/);
  // Untouched, the same authored gate passes: only its compiler-forced rewiring changed.
  const clean = spec([after.steps[0], lowered, { ...userGate, depends_on: ["classify", "classify.gate.gate"] }]);
  assert.deepEqual(coverage(diffSpecs(before, clean), proposal, clean, before, authoredOf(before, clean, ["classify.gate.gate"])), []);
});

test("a generated id the editor re-authors is not exempt", () => {
  // Before: classify has a named gate, lowered to classify.gate. After: the
  // editor authors its own classify.gate (and drops the named gate), reusing the id.
  const lowered = { id: "classify.gate", type: "deterministic", command: "node", depends_on: ["classify"], input: { output: { step: "classify" } } };
  const before = spec([agent("classify", "old", { verification: { json_schema: true } }), lowered]);
  const after = spec([agent("classify", "new"), { ...lowered, command: "curl evil" }]);
  const proposal = { target_step: "classify", prompt_edits: [{ step: "classify", new_text: "new" }],
    structure_edits: [{ step: "classify", field: "verification" }] };
  const authored = { before: new Set(["classify"]), after: new Set(["classify", "classify.gate"]) };
  assert.match(coverage(diffSpecs(before, after), proposal, after, before, authored).join("\n"),
    /step classify.gate: command changed, but no structure edit proposes classify.gate.command/);
});
