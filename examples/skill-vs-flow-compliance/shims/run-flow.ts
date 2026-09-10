// REPLACE-WHEN: the real authored executor lowers postfix `.gate()`
// (packages/sdk/src/authored-flow-operation.ts currently throws
// `unsupported_gate`) and `flows run --local-agent` bypasses the target
// CLI's own permission prompts for a file-editing agent step. Until then
// this is the entry point — same shape and same justification as
// examples/research/shims/run.ts, which this file's agent invocation
// reuses directly (../../research/shims/headless.ts).
//
//   node --experimental-strip-types shims/run-flow.ts --run N
//
// Writes runs/relayflow/run-<N>/{repo/,attempt-1-*.txt,attempt-2-*.txt,verdict.json}.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import complianceFlow, {
  GateFailed,
  type CheckStepResult,
  type ComplianceFlowContext,
  type ImplementResult,
  type Step,
} from "../compliance-flow.ts";
import { headlessInvocation, parseHeadless } from "../../research/shims/headless.ts";
import {
  EXAMPLE_ROOT,
  commitLog,
  diffAgainstBaseline,
  materializeTrialRepo,
  readTaskBrief,
  runCheck,
  writeJson,
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

/** Wraps a plain promise as a Step<T>: `.gate()` fails closed synchronously
 *  once the value resolves (throwing before the caller's `await` sees a
 *  value), and only one gate may be registered per step here — enough for
 *  this flow's usage, unlike research's shim which supports chained gates. */
function asStep<T>(promise: Promise<T>): Step<T> {
  return {
    gate(predicate, because) {
      return asStep(
        promise.then((value) => {
          if (!predicate(value)) throw new Error(`gate_failed${because ? `: ${because}` : ""}`);
          return value;
        }),
      );
    },
    then: (onFulfilled, onRejected) => promise.then(onFulfilled, onRejected),
  };
}

async function main(): Promise<number> {
  const runArg = process.argv.indexOf("--run");
  const runId = runArg >= 0 ? process.argv[runArg + 1] : undefined;
  if (!runId) {
    process.stderr.write("usage: run-flow.ts --run <n>\n");
    return 2;
  }

  const evidenceDir = join(EXAMPLE_ROOT, "runs", "relayflow", `run-${runId}`);
  const repoDir = join(evidenceDir, "repo");
  await mkdir(evidenceDir, { recursive: true });
  // withSkill: false — the flow never installs SKILL.md. It has no skill
  // to forget; the four rules live in the gate, not in the agent's context.
  await materializeTrialRepo(repoDir, { withSkill: false });
  const task = await readTaskBrief();

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
        const { argv } = headlessInvocation("claude", { promptFile, cwd: repoDir });
        const spawned = await spawnCapture(argv, repoDir, options.task);
        await writeFile(logFile, `${spawned.stdout}\n--- stderr ---\n${spawned.stderr}`, "utf8");
        if (spawned.code !== 0) throw new Error(`agent step "${name}" (${label}): claude exited ${spawned.code}`);
        const parsed = parseHeadless("claude", spawned.stdout);
        return { summary: parsed.finalText };
      })();
      return asStep(promise);
    },
    check(name) {
      return asStep(runCheck(repoDir, name));
    },
    done(reason, details) {
      return { completionReason: reason, ...details };
    },
  };

  try {
    const result = await complianceFlow.run(context, { repoDir, task });
    await writeFile(join(evidenceDir, "diff.patch"), await diffAgainstBaseline(repoDir), "utf8");
    await writeFile(join(evidenceDir, "commits.txt"), await commitLog(repoDir), "utf8");
    await writeJson(join(evidenceDir, "verdict.json"), { runId, ok: true, ...result });
    process.stdout.write(`RUN ${runId} completionReason: ${result.completionReason} (${result.attempts} attempt(s))\n`);
    for (const c of result.checks) process.stdout.write(`  ${c.pass ? "PASS" : "FAIL"} ${c.name}: ${c.message}\n`);
    return 0;
  } catch (error) {
    await writeFile(join(evidenceDir, "diff.patch"), await diffAgainstBaseline(repoDir), "utf8").catch(() => undefined);
    await writeFile(join(evidenceDir, "commits.txt"), await commitLog(repoDir), "utf8").catch(() => undefined);
    if (error instanceof GateFailed) {
      await writeJson(join(evidenceDir, "verdict.json"), {
        runId,
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
    await writeJson(join(evidenceDir, "verdict.json"), { runId, ok: false, completionReason: "worker_error", message });
    process.stderr.write(`RUN ${runId} FAILED completionReason: worker_error — ${message}\n`);
    return 1;
  }
}

process.exitCode = await main();
