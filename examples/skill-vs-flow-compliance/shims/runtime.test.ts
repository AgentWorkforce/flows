import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { materializeTrialRepo, reserveEvidence, runChecks, runCheck, diffAgainstBaseline } from "./trial-runtime.ts";
import { sanitizeTranscript } from "./sanitize-transcript.ts";
import flow, { GateFailed, type ComplianceFlowContext, type Step } from "../compliance-flow.ts";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}
async function fixture(fn: (dir: string) => Promise<void>): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), "compliance-test-"));
  try { const dir = join(parent, "repo"); await materializeTrialRepo(dir); await fn(dir); }
  finally { await rm(parent, { recursive: true, force: true }); }
}
async function fix(dir: string): Promise<void> {
  const file = join(dir, "src/calculator.ts");
  await writeFile(file, (await readFile(file, "utf8")).replace("return a / b;", 'if (b === 0) throw new RangeError("zero"); return a / b;'));
  const testFile = join(dir, "test/calculator.test.ts");
  await writeFile(testFile, (await readFile(testFile, "utf8")) + '\ntest("zero", () => assert.throws(() => divide(1, 0), RangeError));\n');
  git(dir, "add", "src", "test"); git(dir, "commit", "-qm", "fix: reject zero");
}

test("existing evidence and repository are refused without changing bytes", () => fixture(async dir => {
  const before = git(dir, "rev-parse", "HEAD");
  await assert.rejects(reserveEvidence(dir), { code: "EEXIST" });
  await assert.rejects(materializeTrialRepo(dir), { code: "EEXIST" });
  assert.equal(git(dir, "rev-parse", "HEAD"), before);
}));

test("host tool settings stay local without blocking a committed task", () => fixture(async dir => {
  await fix(dir);
  await mkdir(join(dir, ".claude"));
  await writeFile(join(dir, ".claude/settings.json"), '{"permissions":{}}\n');
  assert.deepEqual((await runChecks(dir)).map(c => c.pass), [true, true, true, true]);
  assert.doesNotMatch(await diffAgainstBaseline(dir), /settings.json/);
}));

test("empty and deletion-only scans pass; an invalid baseline fails", () => fixture(async dir => {
  for (const name of ["check-no-debug-artifacts", "check-no-secrets"] as const) {
    assert.equal((await runCheck(dir, name)).pass, true);
  }
  git(dir, "rm", "src/calculator.ts"); git(dir, "commit", "-qm", "chore: remove source");
  for (const name of ["check-no-debug-artifacts", "check-no-secrets"] as const) {
    assert.equal((await runCheck(dir, name)).pass, true);
  }
  git(dir, "tag", "-d", "baseline");
  assert.equal((await runCheck(dir, "check-no-secrets")).pass, false);
}));

test("compliant final tree passes all checks; violating commit fails all four", () => fixture(async dir => {
  await fix(dir);
  assert.deepEqual((await runChecks(dir)).map(c => c.pass), [true, true, true, true]);
  git(dir, "checkout", "baseline", "--", "test/calculator.test.ts");
  const file = join(dir, "src/calculator.ts");
  await writeFile(file, (await readFile(file, "utf8")) + '\nconsole.log("debug");\nconst apiKey = "abcdefghijklmnop123456";\n');
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "bad message");
  assert.deepEqual((await runChecks(dir)).map(c => c.pass), [false, false, false, false]);
}));

test("uncommitted repair cannot hide failing committed test; all work is captured", () => fixture(async dir => {
  await fix(dir);
  const file = join(dir, "test/calculator.test.ts");
  const good = await readFile(file, "utf8");
  await writeFile(file, good + '\ntest("broken", () => assert.fail("broken"));\n');
  git(dir, "add", "test"); git(dir, "commit", "-qm", "test: broken");
  await writeFile(file, good);
  await writeFile(join(dir, "new.txt"), "untracked evidence\n");
  await writeFile(join(dir, "staged.txt"), "staged evidence\n"); git(dir, "add", "staged.txt");
  const check = await runCheck(dir, "check-tests-pass");
  assert.equal(check.pass, false); assert.match(check.message, /not clean/);
  const patch = await diffAgainstBaseline(dir);
  assert.match(patch, /untracked evidence/); assert.match(patch, /staged evidence/);
  assert.match(patch, /test\("zero"/); assert.doesNotMatch(patch, /test\("broken"/);
}));

test("sanitization retains Skill calls and task results, removes host metadata", () => {
  const raw = JSON.stringify({ type: "system", subtype: "init", model: "haiku", tools: ["private-tool"], session_id: "private-id" }) + '\n' +
    JSON.stringify({ type: "assistant", session_id: "private-id", message: { content: [{type:"tool_use", name:"Skill", input:{skill:"engineering-conventions"}}] } }) + '\n/home/alice/repo alice@company.test\nAuthor: Alice Example <alice@company.test>\ndrwxr-xr-x 2 alice staff 64 Sep 10 10:00 test';
  const clean = sanitizeTranscript(raw);
  assert.match(clean, /"name":"Skill"/); assert.match(clean, /haiku/);
  assert.doesNotMatch(clean, /private-tool|private-id|alice|Alice Example|staff|company\.test/);
  assert.equal(sanitizeTranscript(clean), clean);
});

for (const scenario of ["first-pass", "repair", "still-failing"] as const) {
  test(`flow control: ${scenario}`, async () => {
    let attempts = 0, done = false;
    const prompts: string[] = [];
    const step = <T>(value: T): Step<T> => ({ then: Promise.resolve(value).then.bind(Promise.resolve(value)) });
    const context: ComplianceFlowContext = {
      agent(_name, options) { attempts++; prompts.push(options.task); return step({summary:"done"}); },
      check(name) { return step({ name, pass: scenario === "first-pass" || (scenario === "repair" && attempts === 2), message:"specific failure" }); },
      done(reason, details) { done = true; return {completionReason:reason, ...details}; },
    };
    if (scenario === "still-failing") {
      await assert.rejects(flow.run(context, {repoDir:"unused",task:"task"}), (error: unknown) => {
        assert.ok(error instanceof GateFailed); assert.equal(error.attemptHistory.length, 2); return true;
      });
      assert.equal(done, false);
    } else { assert.equal((await flow.run(context, {repoDir:"unused",task:"task"})).completionReason, "success"); }
    assert.equal(attempts, scenario === "first-pass" ? 1 : 2);
    if (attempts === 2) assert.match(prompts[1]!, /specific failure/);
  });
}
