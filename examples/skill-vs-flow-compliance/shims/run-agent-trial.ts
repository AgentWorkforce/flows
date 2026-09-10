// Arm A: a coding agent that has SKILL.md installed as a real Claude Code
// project skill (.claude/skills/engineering-conventions/SKILL.md) and is
// given ONLY the task — the same brief arm B's flow gives its agent step.
// Nothing in the prompt mentions the skill; whether it gets applied depends
// entirely on the agent noticing it applies and choosing to follow it. No
// deterministic check runs *during* the agent's work; checks only score the
// result afterward, exactly like a human reviewer reading a PR after the
// fact.
//
//   node --experimental-strip-types shims/run-agent-trial.ts --trial N [--no-skill] [--task FILE] [--model NAME] [--scenario NAME] [--nudge-skill]
//
// Writes runs/<scenario->agent-plus-skill/trial-<N>/{prompt.md,transcript.txt,diff.patch,verdict.json},
// or runs/<scenario->agent-no-skill/trial-<N>/... with --no-skill — the
// control arm: same task, same model, no skill installed, so a skill's
// marginal effect (not just the agent's baseline competence) is visible in
// the evidence. --task/--model/--scenario let a second, harder scenario
// (TASK-HARD.md, a cheaper model) reuse this same harness and scoring.
//
// --nudge-skill requests that the agent look for applicable project skills.
// This changes the initial prompt; it does not force discovery or establish
// full skill compliance. See README.md for the measured final-state proxies.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  headlessInvocation,
  parseHeadless,
  type HeadlessResult,
} from "../../research/shims/headless.ts";
import { sanitizeTranscript } from "./sanitize-transcript.ts";
import { spawn } from "node:child_process";
import {
  EXAMPLE_ROOT,
  commitLog,
  diffAgainstBaseline,
  materializeTrialRepo,
  reserveEvidence,
  readTaskBrief,
  runChecks,
  writeJson,
  type CheckOutcome,
} from "./trial-runtime.ts";

function spawnCapture(argv: string[], cwd: string, stdin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    if (!cmd) throw new Error("empty argv");
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.once("error", reject);
    child.stdin.on("error", reject);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.once("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
    child.stdin.end(stdin);
  });
}

const SKILL_DISCOVERY_NUDGE =
  "\n\nBefore you start, check whether this repository has any installed " +
  "project skills that apply to this kind of change, and use whatever " +
  "applies.";

function argAfter(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const trial = argAfter("--trial");
  const withSkill = !process.argv.includes("--no-skill");
  const taskFile = argAfter("--task") ?? "TASK.md";
  const model = argAfter("--model");
  const scenario = argAfter("--scenario");
  const nudgeSkill = process.argv.includes("--nudge-skill");
  if (!trial) {
    process.stderr.write("usage: run-agent-trial.ts --trial <n> [--no-skill] [--task FILE] [--model NAME] [--scenario NAME] [--nudge-skill]\n");
    return 2;
  }
  if (nudgeSkill && !withSkill) {
    process.stderr.write("--nudge-skill has nothing to nudge toward with --no-skill\n");
    return 2;
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(trial) || (scenario && !/^[a-zA-Z0-9_-]+$/.test(scenario))) throw new Error("invalid run/trial or scenario name");

  const armBase = withSkill ? "agent-plus-skill" : "agent-no-skill";
  const arm = scenario ? `${armBase}-${scenario}` : armBase;
  const evidenceDir = join(EXAMPLE_ROOT, "runs", arm, `trial-${trial}`);
  const repoDir = join(evidenceDir, "repo");
  await reserveEvidence(evidenceDir);
  await materializeTrialRepo(repoDir, { withSkill });

  // This is the whole of arm A's setup: the skill sits in the repo as a real
  // project skill. The prompt is the bare task — identical to what arm B's
  // flow hands its agent step, plus the discovery nudge above when
  // requested. The agent is trusted to find the skill and apply it; nothing
  // here enforces that it does, and nothing here pastes what the skill says.
  const prompt = (await readTaskBrief(taskFile)) + (nudgeSkill ? SKILL_DISCOVERY_NUDGE : "");
  await writeFile(join(evidenceDir, "prompt.md"), prompt, "utf8");

  // headlessInvocation already includes --dangerously-skip-permissions for
  // claude (see headless.ts); nothing is added here.
  const { argv } = headlessInvocation("claude", { promptFile: join(evidenceDir, "prompt.md"), cwd: repoDir, model });
  const spawned = await spawnCapture(argv, repoDir, prompt);
  // .txt, not .log: this repo's root .gitignore excludes *.log, and this
  // transcript is the evidence a claim in README.md cites, not a disposable
  // debug trace — it needs to actually be committed.
  await writeFile(join(evidenceDir, "transcript.txt"), sanitizeTranscript(`${spawned.stdout}\n--- stderr ---\n${spawned.stderr}`), "utf8");

  let parsed: HeadlessResult | undefined;
  let workerError: string | undefined;
  if (spawned.code !== 0) {
    workerError = `claude exited ${spawned.code}`;
  } else {
    try {
      parsed = parseHeadless("claude", spawned.stdout);
    } catch (error) {
      workerError = String(error);
    }
  }

  const diff = await diffAgainstBaseline(repoDir);
  await writeFile(join(evidenceDir, "diff.patch"), diff, "utf8");
  const log = await commitLog(repoDir);
  await writeFile(join(evidenceDir, "commits.txt"), log, "utf8");

  const checks: CheckOutcome[] = workerError ? [] : await runChecks(repoDir);
  const allPass = !workerError && checks.every((c) => c.pass);

  await writeJson(join(evidenceDir, "verdict.json"), {
    trial,
    arm,
    task: taskFile,
    model: model ?? "default",
    nudgedSkillDiscovery: nudgeSkill,
    workerError,
    finalMessage: parsed ? sanitizeTranscript(parsed.finalText) : undefined,
    completionReason: workerError ? "worker_error" : allPass ? "success" : "gate_failed",
    usage: parsed?.usage,
    checks,
    allPass,
  });

  process.stdout.write(
    `trial ${trial}: ${workerError ? `WORKER_ERROR ${workerError}` : allPass ? "ALL CHECKS PASS" : "NONCOMPLIANT"}\n`,
  );
  for (const c of checks) process.stdout.write(`  ${c.pass ? "PASS" : "FAIL"} ${c.name}: ${c.message}\n`);
  return 0;
}

process.exitCode = await main();
