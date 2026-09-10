// Arm A: a coding agent that has SKILL.md installed as a real Claude Code
// project skill (.claude/skills/engineering-conventions/SKILL.md) and is
// given ONLY the task — the same brief arm B's flow gives its agent step.
// Nothing in the prompt mentions the skill; whether it gets applied depends
// entirely on the agent noticing it applies and choosing to follow it. No
// deterministic check runs *during* the agent's work; checks only score the
// result afterward, exactly like a human reviewer reading a PR after the
// fact.
//
//   node --experimental-strip-types shims/run-agent-trial.ts --trial N [--no-skill]
//
// Writes runs/agent-plus-skill/trial-<N>/{prompt.md,transcript.log,diff.patch,verdict.json},
// or runs/agent-no-skill/trial-<N>/... with --no-skill — the control arm:
// same task, same model, no skill installed, so a skill's marginal effect
// (not just the agent's baseline competence) is visible in the evidence.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  headlessInvocation,
  parseHeadless,
  type HeadlessResult,
} from "../../research/shims/headless.ts";
import { spawn } from "node:child_process";
import {
  EXAMPLE_ROOT,
  commitLog,
  diffAgainstBaseline,
  materializeTrialRepo,
  readTaskBrief,
  runChecks,
  writeJson,
  type CheckOutcome,
} from "./trial-runtime.ts";

function spawnCapture(argv: string[], cwd: string, stdin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    if (!cmd) throw new Error("empty argv");
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.once("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
    child.stdin.end(stdin);
  });
}

async function main(): Promise<number> {
  const trialArg = process.argv.indexOf("--trial");
  const trial = trialArg >= 0 ? process.argv[trialArg + 1] : undefined;
  const withSkill = !process.argv.includes("--no-skill");
  if (!trial) {
    process.stderr.write("usage: run-agent-trial.ts --trial <n> [--no-skill]\n");
    return 2;
  }

  const arm = withSkill ? "agent-plus-skill" : "agent-no-skill";
  const evidenceDir = join(EXAMPLE_ROOT, "runs", arm, `trial-${trial}`);
  const repoDir = join(evidenceDir, "repo");
  await mkdir(evidenceDir, { recursive: true });
  await materializeTrialRepo(repoDir, { withSkill });

  // This is the whole of arm A's setup: the skill sits in the repo as a real
  // project skill. The prompt is the bare task — identical to what arm B's
  // flow hands its agent step. The agent is trusted to find the skill and
  // apply it; nothing here enforces that it does.
  const prompt = await readTaskBrief();
  await writeFile(join(evidenceDir, "prompt.md"), prompt, "utf8");

  // headlessInvocation already includes --dangerously-skip-permissions for
  // claude (see headless.ts); nothing is added here.
  const { argv } = headlessInvocation("claude", { promptFile: join(evidenceDir, "prompt.md"), cwd: repoDir });
  const spawned = await spawnCapture(argv, repoDir, prompt);
  // .txt, not .log: this repo's root .gitignore excludes *.log, and this
  // transcript is the evidence a claim in README.md cites, not a disposable
  // debug trace — it needs to actually be committed.
  await writeFile(join(evidenceDir, "transcript.txt"), `${spawned.stdout}\n--- stderr ---\n${spawned.stderr}`, "utf8");

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
    workerError,
    finalMessage: parsed?.finalText,
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
