// Shared plumbing for both arms of the comparison: materializing an isolated
// copy of fixture/ as its own git repo (so neither arm's commits ever touch
// the other's, or this repo's), and running the four deterministic checks
// against whatever a trial produced. The checks themselves live in
// ../checks/*.sh — this file shells out to them rather than reimplementing
// their logic, so "what the flow gates on" and "what scores the agent+skill
// arm" are provably the same script, not two hand-synced copies of a rule.

import { spawn } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Claude Code's real project-skill location: a skill dropped here is
 *  auto-discovered by name/description match, the same way it would be in
 *  a real project — never force-pasted into the prompt. That is the actual
 *  claim under test: does the agent find and apply it on its own. */
export const SKILL_INSTALL_PATH = ".claude/skills/engineering-conventions/SKILL.md";

const HERE = dirname(fileURLToPath(import.meta.url));
export const EXAMPLE_ROOT = resolve(HERE, "..");
export const FIXTURE_DIR = join(EXAMPLE_ROOT, "fixture");
export const CHECKS_DIR = join(EXAMPLE_ROOT, "checks");
export const BASE_REF = "baseline";

export const CHECK_NAMES = [
  "check-tests-pass",
  "check-no-debug-artifacts",
  "check-no-secrets",
  "check-commit-message",
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export interface CheckOutcome {
  name: CheckName;
  pass: boolean;
  message: string;
}

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { cwd });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.once("close", (code) => res({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

/** Copies fixture/ into `dir`, optionally installs SKILL.md at Claude Code's
 *  real project-skill path, commits the result as `chore: baseline`, tags
 *  it `baseline`. Every check diffs against this tag, never against main.
 *  Installing the skill (or not) is the ONLY difference between the two
 *  agent-side trial dirs this example runs — the task prompt is identical
 *  either way, so a compliance difference can only come from the skill. */
export async function materializeTrialRepo(dir: string, options: { withSkill: boolean } = { withSkill: false }): Promise<void> {
  await mkdir(dir, { recursive: true });
  await cp(FIXTURE_DIR, dir, { recursive: true });
  if (options.withSkill) {
    const skillPath = join(dir, SKILL_INSTALL_PATH);
    await mkdir(dirname(skillPath), { recursive: true });
    await cp(join(EXAMPLE_ROOT, "SKILL.md"), skillPath);
  }
  await run("git", ["init", "-q"], dir);
  await run("git", ["add", "-A"], dir);
  await run("git", ["-c", "user.email=trial@example.invalid", "-c", "user.name=trial", "commit", "-qm", "chore: baseline"], dir);
  await run("git", ["tag", BASE_REF], dir);
}

/** Runs one deterministic check script against `dir` relative to BASE_REF.
 *  Never throws: the script's own nonzero exit is a recorded FAIL, not a
 *  crash of whatever is scoring it. Both arms call this — arm A's trial
 *  runner scores a finished diff with it after the fact; the flow's
 *  `check()` verb calls it as a step DURING the run, before deciding
 *  whether it may finish. */
export async function runCheck(dir: string, name: CheckName): Promise<CheckOutcome> {
  const script = join(CHECKS_DIR, `${name}.sh`);
  const result = await run("sh", [script, dir, BASE_REF], dir);
  const message = (result.stdout.trim() || result.stderr.trim()).split("\n")[0] ?? "";
  return { name, pass: result.code === 0, message };
}

/** Runs all four deterministic checks against `dir` relative to BASE_REF. */
export async function runChecks(dir: string): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  for (const name of CHECK_NAMES) {
    outcomes.push(await runCheck(dir, name));
  }
  return outcomes;
}

export async function readTaskBrief(): Promise<string> {
  return readFile(join(EXAMPLE_ROOT, "TASK.md"), "utf8");
}

export async function readSkill(): Promise<string> {
  return readFile(join(EXAMPLE_ROOT, "SKILL.md"), "utf8");
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function diffAgainstBaseline(dir: string): Promise<string> {
  const result = await run("git", ["diff", `${BASE_REF}...HEAD`], dir);
  return result.stdout;
}

export async function commitLog(dir: string): Promise<string> {
  const result = await run("git", ["log", "--format=%H %s", `${BASE_REF}..HEAD`], dir);
  return result.stdout;
}
