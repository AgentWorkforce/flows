// Userland runner for the illustrative flow. It reuses research's headless
// CLI adapter; it does not submit a spec to the kernel or journal execution.
//
//   node --experimental-strip-types shims/run-flow.ts --run N [--task FILE] [--model NAME] [--scenario NAME]
//
// Writes runs/relayflow<-scenario>/run-<N>/{repo/,attempt-1-*.txt,attempt-2-*.txt,verdict.json}.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeTranscript } from "./sanitize-transcript.ts";
import { spawn } from "node:child_process";
import complianceFlow, {
  GateFailed,
  type CheckStepResult,
  type ComplianceFlowContext,
  type ImplementResult,
} from "../compliance-flow.ts";
import { headlessInvocation, parseHeadless } from "../../research/shims/headless.ts";
import {
  EXAMPLE_ROOT,
  commitLog,
  diffAgainstBaseline,
  materializeTrialRepo,
  reserveEvidence,
  readTaskBrief,
  runCheck,
  writeJson,
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

function argAfter(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const runId = argAfter("--run");
  const taskFile = argAfter("--task") ?? "TASK.md";
  const model = argAfter("--model");
  const scenario = argAfter("--scenario");
  if (!runId) {
    process.stderr.write("usage: run-flow.ts --run <n> [--task FILE] [--model NAME] [--scenario NAME]\n");
    return 2;
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(runId) || (scenario && !/^[a-zA-Z0-9_-]+$/.test(scenario))) throw new Error("invalid run/trial or scenario name");

  const armDir = scenario ? `relayflow-${scenario}` : "relayflow";
  const evidenceDir = join(EXAMPLE_ROOT, "runs", armDir, `run-${runId}`);
  const repoDir = join(evidenceDir, "repo");
  await reserveEvidence(evidenceDir);
  // withSkill: false — the flow never installs SKILL.md. It has no skill
  // to forget; the four rules live in the gate, not in the agent's context.
  await materializeTrialRepo(repoDir, { withSkill: false });
  const task = await readTaskBrief(taskFile);

  let attempt = 0;
  const context: ComplianceFlowContext = {
    agent(name, options) {
      const label = `attempt-${(attempt += 1)}-${name}`;
      const promise = (async (): Promise<ImplementResult> => {
        const promptFile = join(evidenceDir, `${label}.prompt.md`);
        // .txt, not .log: this repo's root .gitignore excludes *.log, and
        // this transcript is cited evidence, not a disposable debug trace.
        const logFile = join(evidenceDir, `${label}.txt`);
        await writeFile(promptFile, options.task, "utf8");
        const { argv } = headlessInvocation("claude", { promptFile, cwd: repoDir, model });
        const spawned = await spawnCapture(argv, repoDir, options.task);
        await writeFile(logFile, sanitizeTranscript(`${spawned.stdout}\n--- stderr ---\n${spawned.stderr}`), "utf8");
        if (spawned.code !== 0) throw new Error(`agent step "${name}" (${label}): claude exited ${spawned.code}`);
        const parsed = parseHeadless("claude", spawned.stdout);
        return { summary: parsed.finalText };
      })();
      return promise;
    },
    check(name) {
      return runCheck(repoDir, name);
    },
    done(reason, details) {
      return { completionReason: reason, ...details };
    },
  };

  try {
    const result = await complianceFlow.run(context, { repoDir, task });
    await writeFile(join(evidenceDir, "diff.patch"), await diffAgainstBaseline(repoDir), "utf8");
    await writeFile(join(evidenceDir, "commits.txt"), await commitLog(repoDir), "utf8");
    await writeJson(join(evidenceDir, "verdict.json"), { runId, task: taskFile, model: model ?? "default", ok: true, ...result });
    process.stdout.write(`RUN ${runId} completionReason: ${result.completionReason} (${result.attempts} attempt(s))\n`);
    for (const c of result.checks) process.stdout.write(`  ${c.pass ? "PASS" : "FAIL"} ${c.name}: ${c.message}\n`);
    return 0;
  } catch (error) {
    await writeFile(join(evidenceDir, "diff.patch"), await diffAgainstBaseline(repoDir), "utf8");
    await writeFile(join(evidenceDir, "commits.txt"), await commitLog(repoDir), "utf8");
    if (error instanceof GateFailed) {
      await writeJson(join(evidenceDir, "verdict.json"), {
        runId,
        task: taskFile,
        model: model ?? "default",
        ok: false,
        completionReason: error.completionReason,
        failedChecks: error.failedChecks,
        checks: error.checks,
        attemptHistory: error.attemptHistory,
      });
      process.stderr.write(`RUN ${runId} FAILED completionReason: gate_failed — ${error.message}\n`);
      for (const c of error.checks) process.stderr.write(`  ${c.pass ? "PASS" : "FAIL"} ${c.name}: ${c.message}\n`);
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    await writeJson(join(evidenceDir, "verdict.json"), { runId, task: taskFile, model: model ?? "default", ok: false, completionReason: "worker_error", message });
    process.stderr.write(`RUN ${runId} FAILED completionReason: worker_error — ${message}\n`);
    return 1;
  }
}

process.exitCode = await main();
