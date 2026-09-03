// REPLACE-WHEN: `flows run examples/research/research.flow.ts` accepts the v2 dialect
// with caller input. Until then this is the entry point: it builds the flow
// context from the CLI shim, materializes a run directory, and executes the
// flow. Nothing here is flow logic — the flow is research.flow.ts.
//
//   node --experimental-strip-types examples/research/shims/run.ts \
//     --slug agent-memory --question-file examples/research/questions/agent-memory.md
//
// Exit 0 with the result on stdout when the flow completes `synthesized`;
// exit 1 with the failed step and its completionReason on stderr; exit 2
// when refused before anything ran (bad arguments, failed CLI preflight,
// non-empty run dir) — the same exit contract as `flows run`.

import { lstat, mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import researchFlow, {
  type AgentName,
  type ResearchFlowContext,
  type ResearchFlowDefinition,
  type ResearchInput,
  type ResearchResult,
  type Step,
} from "../research.flow.ts";
import { AgentStepFailed, killLiveAgents, runAgentWithCli, type AgentRunner } from "./agent-cli.ts";
import type { CompletionReason } from "../research.flow.ts";
import { isHeadlessCli, preflightHeadless, type HeadlessBinaries, type HeadlessCli } from "./headless.ts";

export class GateFailed extends Error {
  readonly step: AgentName;
  readonly completionReason: Extract<CompletionReason, "gate_failed"> = "gate_failed";
  readonly because: string | undefined;
  constructor(step: AgentName, because: string | undefined) {
    super(`gate_failed on step "${step}"${because ? `: ${because}` : ""}`);
    this.step = step;
    this.because = because;
  }
}

export interface RuntimeOptions {
  runAgent: AgentRunner;
  cwd: string;
  /** Per STEP, not per run: each of the four agent steps gets this much. */
  timeoutMs: number;
  /** Binary per CLI; the entry point leaves it unset (PATH), tests set stubs. */
  binaries?: HeadlessBinaries;
}

export class LateGate extends Error {
  constructor(step: AgentName) {
    super(`step "${step}": .gate() called after the step was awaited; the gate would never run`);
  }
}

/** A thenable with postfix gates (SURFACE.md §2 law 2). Gates run in order
 *  after the step resolves; the first false predicate fails the step.
 *
 *  Gates are SEALED at the first `then`. A `.gate()` registered after the
 *  step has been awaited would silently never be evaluated — a fail-open
 *  gate, the exact class AGENTS.md rule 4 forbids — so it throws instead. */
function step<T>(name: AgentName, promise: Promise<T>): Step<T> {
  const gates: Array<{ predicate: (value: T) => boolean; because?: string }> = [];
  let sealed = false;
  let gated: Promise<T> | undefined;
  const build = (): Promise<T> => {
    sealed = true;
    gated ??= promise.then((value) => {
      for (const gate of gates) {
        if (!gate.predicate(value)) throw new GateFailed(name, gate.because);
      }
      return value;
    });
    return gated;
  };
  // A step nobody awaits must still not leave an unhandled rejection.
  promise.catch(() => undefined);
  return {
    gate(predicate, because) {
      if (sealed) throw new LateGate(name);
      gates.push({ predicate, because });
      return this;
    },
    then: (onFulfilled, onRejected) => build().then(onFulfilled, onRejected),
  };
}

export function createContext(
  definition: ResearchFlowDefinition,
  runtime: RuntimeOptions,
  signal?: AbortSignal,
): ResearchFlowContext {
  return {
    agent(name, options) {
      const agentDefinition = definition.header.agents[name];
      return step(
        name,
        runtime.runAgent({
          name,
          definition: agentDefinition,
          task: options.task,
          workspace: options.workspace,
          cwd: runtime.cwd,
          timeoutMs: runtime.timeoutMs,
          binaries: runtime.binaries,
          signal,
        }),
      );
    },
    done(reason, details) {
      return { completionReason: reason, ...details };
    },
  };
}

/** The abort controller of the run in progress, so an operator signal can
 *  stop every agent the same way a failed step does. */
let currentAbort: AbortController | undefined;

/** Stop everything: abort so unspawned steps never start, kill and await
 *  the live ones. Called from the failure path and from SIGINT/SIGTERM. */
export async function stopEverything(): Promise<number> {
  currentAbort?.abort();
  return killLiveAgents();
}

export async function runResearch(
  input: ResearchInput,
  runtime: RuntimeOptions,
): Promise<ResearchResult> {
  const abort = new AbortController();
  currentAbort = abort;
  try {
    return await researchFlow.run(createContext(researchFlow, runtime, abort.signal), input);
  } catch (error) {
    // Fail fast for real: a rejected Promise.all leaves sibling lanes running
    // and spending until their own timeout. Abort first so a sibling that
    // has not spawned yet never does, then kill and await the ones that had.
    abort.abort();
    const killed = await killLiveAgents();
    if (killed > 0) process.stderr.write(`research: killed ${killed} still-running agent step(s) after failure\n`);
    throw error;
  }
}

// --- CLI entry -------------------------------------------------------------

interface CliArgs {
  slug: string;
  question: string;
  runsDir: string;
  timeoutMs: number;
}

export class Refused extends Error {}

/** Injectable seams for main(): tests substitute stub binaries and a fake
 *  runner; the CLI entry below passes the real ones. */
export interface MainDeps {
  runAgent: AgentRunner;
  binaries?: HeadlessBinaries;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** Argument errors are refusals (exit 2), not protocol errors. */
async function parseArgs(argv: readonly string[]): Promise<CliArgs> {
  let slug: string | undefined;
  let question: string | undefined;
  let runsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "runs");
  let timeoutMs = 30 * 60 * 1000;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    const need = (): string => {
      if (value === undefined || value.startsWith("--")) throw new Refused(`${flag} needs a value`);
      index += 1;
      return value;
    };
    if (flag === "--slug") slug = need();
    else if (flag === "--question") question = need();
    else if (flag === "--question-file") {
      const file = need();
      question = await readFile(file, "utf8").catch((error: unknown) => { throw new Refused(`--question-file ${file}: ${String(error)}`); });
    }
    else if (flag === "--runs-dir") runsDir = resolve(need());
    else if (flag === "--timeout-minutes") timeoutMs = Number.parseInt(need(), 10) * 60 * 1000; // per step
    else throw new Refused(`unknown argument ${flag}`);
  }
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/u.test(slug)) throw new Refused("--slug <kebab-case> is required");
  if (!question || question.trim() === "") throw new Refused("--question <text> or --question-file <path> is required");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Refused("--timeout-minutes must be a positive integer");
  return { slug, question, runsDir, timeoutMs };
}

export async function main(argv: readonly string[], deps: MainDeps): Promise<number> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  try {
    const args = await parseArgs(argv);

    // EVERY refusal happens here, before a single file is created, so exit 2
    // always means "nothing was touched" — no half-materialized run dir that
    // poisons the slug for the next attempt.
    //
    // 1. Preflight: a missing or unauthenticated CLI is refused now, never
    //    discovered at minute 27 (SURFACE.md covenant 2).
    const clis = Object.values(researchFlow.header.agents).map((a) => a.cli);
    const unknown = clis.filter((cli) => !isHeadlessCli(cli));
    if (unknown.length > 0) throw new Refused(`no headless adapter for cli: ${unknown.join(", ")}`);
    const findings = preflightHeadless(clis as HeadlessCli[], deps.binaries);
    if (findings.length > 0) {
      throw new Refused(findings.map((f) => `[${f.kind}] ${f.message}`).join("\n"));
    }
    // 2. The run dir is the durable record; a second run must not interleave
    //    with a previous one. Only ENOENT means "empty"; any other error is
    //    a refusal, not an empty directory.
    const date = new Date().toISOString().slice(0, 10);
    const runDir = resolve(args.runsDir, `${date}-${args.slug}`);
    const existing = await readdir(runDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw new Refused(`cannot read run dir ${runDir}: ${error.message}`);
    });
    if (existing.length > 0) {
      throw new Refused(`run dir ${runDir} is not empty; pick another --slug or move the previous run`);
    }
    // 3. runs/current must be absent or a symlink we own.
    const current = resolve(args.runsDir, "current");
    const currentStat = await lstat(current).catch(() => undefined);
    if (currentStat !== undefined && !currentStat.isSymbolicLink()) {
      throw new Refused(`${current} exists and is not a symlink; refusing to replace it`);
    }

    await mkdir(runDir, { recursive: true });
    await writeFile(resolve(runDir, "PROMPT.md"), args.question, "utf8");
    await unlink(current).catch(() => undefined);
    await symlink(runDir, current);
    deps.stderr(`research: run dir ${runDir}`);

    const result = await runResearch(
      { question: args.question, runDir },
      { runAgent: deps.runAgent, cwd: repoRoot, timeoutMs: args.timeoutMs, binaries: deps.binaries },
    );
    deps.stdout(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    if (error instanceof Refused) {
      deps.stderr(`REFUSED ${error.message}`);
      return 2;
    }
    if (error instanceof AgentStepFailed) {
      deps.stderr(`FAILED step "${error.step}" completionReason: ${error.completionReason} — ${error.message}`);
    } else if (error instanceof GateFailed) {
      deps.stderr(`FAILED step "${error.step}" completionReason: ${error.completionReason} — ${error.because ?? ""}`);
    } else {
      const reason: CompletionReason = "protocol_error";
      deps.stderr(`FAILED step "(unknown)" completionReason: ${reason} — ${String(error)}`);
    }
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Operator interrupt. The agents are detached process groups running with
  // their permission prompts bypassed; without this, Ctrl-C would orphan
  // them with no timeout left (the per-step timer lives in this process).
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stopEverything().then((stopped) => {
        process.stderr.write(`research: ${signal}; stopped ${stopped} agent step(s)\n`);
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    });
  }
  process.exitCode = await main(process.argv.slice(2), {
    runAgent: runAgentWithCli,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
}
