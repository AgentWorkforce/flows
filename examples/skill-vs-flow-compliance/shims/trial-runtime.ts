// Shared plumbing for both arms of the comparison: materializing an isolated
// copy of fixture/ as its own git repo (so neither arm's commits ever touch
// the other's, or this repo's), and running the four deterministic checks
// against whatever a trial produced. The checks themselves live in
// ../checks/*.sh — this file shells out to them rather than reimplementing
// their logic, so "what the flow gates on" and "what scores the agent+skill
// arm" are provably the same script, not two hand-synced copies of a rule.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Project-skill path used by these Claude trials. The child runs with the
 * trial repo as cwd; invocation is the observed Skill tool call, never
 * guaranteed by placing this file. Host/CLI discovery behavior can change. */
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

// Load before either runner can start an agent. The executed gate source
// lives in this supervisor's private memory, not in files the child can
// overwrite. Passing the captured source to sh -c avoids a mutable temp file.
// Each process must start from a trusted checkout; this is not a filesystem
// sandbox and does not protect other host programs or future invocations.
const checkSources = Object.freeze(Object.fromEntries(CHECK_NAMES.map(name => [
  name, readFileSync(join(CHECKS_DIR, `${name}.sh`), "utf8"),
])) as Record<CheckName, string>);

export interface CheckOutcome {
  name: CheckName;
  pass: boolean;
  message: string;
}

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res, reject) => {
    const child = spawn(cmd, args, { cwd });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.once("error", reject);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.once("close", (code) => res({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

async function mustRun(cmd: string, args: string[], cwd: string): Promise<string> {
  const result = await run(cmd, args, cwd);
  if (result.code !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

/** Atomically reserves a new evidence directory, including after a fresh clone. */
export async function reserveEvidence(dir: string): Promise<void> {
  await mkdir(dirname(dir), { recursive: true });
  await mkdir(dir);
}

/** Copies fixture/ into `dir`, optionally installs SKILL.md at Claude Code's
 *  real project-skill path, commits the result as `chore: baseline`, tags
 *  it `baseline`. Every check diffs against this tag, never against main.
 *  This copies the entire small fixture; keep large generated assets out.
 *  Skill installation changes repo contents; the entry point separately
 *  chooses the task and optional discovery nudge. */
export async function materializeTrialRepo(dir: string, options: { withSkill: boolean } = { withSkill: false }): Promise<void> {
  await mkdir(dir);
  await cp(FIXTURE_DIR, dir, { recursive: true });
  if (options.withSkill) {
    const skillPath = join(dir, SKILL_INSTALL_PATH);
    await mkdir(dirname(skillPath), { recursive: true });
    await cp(join(EXAMPLE_ROOT, "SKILL.md"), skillPath);
  }
  await mustRun("git", ["init", "-q"], dir);
  // Host-generated tool settings are not task output. Keep them local;
  // the installed SKILL.md remains tracked and therefore reviewable.
  await writeFile(join(dir, ".git", "info", "exclude"), ".claude/settings.json\n", "utf8");
  await mustRun("git", ["config", "user.email", "trial@example.invalid"], dir);
  await mustRun("git", ["config", "user.name", "trial"], dir);
  await mustRun("git", ["add", "-A"], dir);
  await mustRun("git", ["-c", "user.email=trial@example.invalid", "-c", "user.name=trial", "commit", "-qm", "chore: baseline"], dir);
  await mustRun("git", ["tag", BASE_REF], dir);
}

/** Runs one deterministic check script against `dir` relative to BASE_REF.
 *  A script's nonzero exit is a recorded FAIL, not a
 *  crash of whatever is scoring it. Both arms call this — arm A's trial
 *  runner scores a finished diff with it after the fact; the flow's
 *  `check()` verb calls it as a step DURING the run, before deciding
 *  whether it may finish. */
export async function runCheck(dir: string, name: CheckName): Promise<CheckOutcome> {
  const result = await run("/bin/sh", ["-c", checkSources[name], name, dir, BASE_REF], dir);
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

export async function readTaskBrief(fileName = "TASK.md"): Promise<string> {
  return readFile(join(EXAMPLE_ROOT, fileName), "utf8");
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function diffAgainstBaseline(dir: string): Promise<string> {
  let patch = await mustRun("git", ["diff", "--binary", BASE_REF, "--"], dir);
  const untracked = await mustRun("git", ["ls-files", "--others", "--exclude-standard", "-z"], dir);
  for (const path of untracked.split("\0").filter(Boolean)) {
    const result = await run("git", ["diff", "--no-index", "--binary", "--", "/dev/null", path], dir);
    if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr);
    patch += result.stdout;
  }
  return patch;
}

export async function commitLog(dir: string): Promise<string> {
  return mustRun("git", ["log", "--format=%H %s", `${BASE_REF}..HEAD`], dir);
}
