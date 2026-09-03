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

import { lstat, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
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
import { AgentStepFailed, describeAbort, killLiveAgents, runAgentWithCli, type AbortCause, type AgentRunner } from "./agent-cli.ts";
import { realpathSync } from "node:fs";
import type { CompletionReason } from "../research.flow.ts";
import { isHeadlessCli, preflightHeadless, type HeadlessBinaries, type PreflightTarget } from "./headless.ts";

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
 *  stop every agent the same way a failed step does.
 *
 *  MODULE-GLOBAL, like `live` in agent-cli.ts: one flow per process is the
 *  only supported shape of this shim. Cleared when the run settles. */
let currentAbort: AbortController | undefined;

/** Stop everything: abort so unspawned steps never start, kill and await
 *  the live ones. Called from the failure path (cause: sibling_failed) and
 *  from SIGINT/SIGTERM (cause: operator_signal), and the cause travels to
 *  every step's transcript marker. */
export async function stopEverything(cause: AbortCause): Promise<number> {
  currentAbort?.abort(cause);
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
    // If the abort was already raised by the operator, keep that cause.
    if (!abort.signal.aborted) abort.abort({ kind: "sibling_failed" } satisfies AbortCause);
    const killed = await killLiveAgents();
    if (killed > 0) process.stderr.write(`research: killed ${killed} still-running agent step(s) after failure\n`);
    throw error;
  } finally {
    currentAbort = undefined;
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

/** The operator interrupted the run; the steps were stopped and recorded.
 *  Not a failure: no `FAILED` line, exit 130/143 by convention. */
export class Interrupted extends Error {
  readonly signal: NodeJS.Signals;
  constructor(signal: NodeJS.Signals) { super(`interrupted by ${signal}`); this.signal = signal; }
}

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
    else if (flag === "--timeout-minutes") {
      const raw = need();
      const minutes = Number(raw);
      if (!Number.isInteger(minutes) || minutes <= 0) throw new Refused(`--timeout-minutes must be a positive integer, got ${raw}`);
      timeoutMs = minutes * 60 * 1000; // per step
    }
    else throw new Refused(`unknown argument ${flag}`);
  }
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/u.test(slug)) throw new Refused("--slug <kebab-case> is required");
  if (!question || question.trim() === "") throw new Refused("--question <text> or --question-file <path> is required");
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
    // 1. Preflight, per declared (cli, model) pair: a missing or
    //    unauthenticated CLI, or one that cannot resolve the declared model,
    //    is refused now, never discovered at minute 27 (SURFACE.md covenant 2).
    const agents = Object.values(researchFlow.header.agents);
    const unknown = agents.map((a) => a.cli).filter((cli) => !isHeadlessCli(cli));
    if (unknown.length > 0) throw new Refused(`no headless adapter for cli: ${unknown.join(", ")}`);
    const targets = agents.filter((a) => isHeadlessCli(a.cli)).map((a) => ({ cli: a.cli, model: a.model })) as PreflightTarget[];
    const findings = await preflightHeadless(targets, deps.binaries);
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
      throw new Refused(`run dir ${runDir} (UTC date) is not empty; pick another --slug or move the previous run`);
    }
    // 3. runs/current must be absent or a symlink we own.
    const current = resolve(args.runsDir, "current");
    const currentStat = await lstat(current).catch(() => undefined);
    if (currentStat !== undefined && !currentStat.isSymbolicLink()) {
      throw new Refused(`${current} exists and is not a symlink; refusing to replace it`);
    }

    // Claim the run dir atomically: a non-recursive mkdir fails with EEXIST
    // if a concurrent invocation with the same slug won the race, so two
    // runs can never share one directory (the readdir check above is only
    // the friendly message for the non-racing case).
    await mkdir(args.runsDir, { recursive: true });
    await mkdir(runDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new Refused(`run dir ${runDir} was created concurrently; pick another --slug`);
      throw error;
    });
    // The symlink is (re)pointed before any run file exists, and a failure
    // here removes the just-claimed empty dir, so exit 2 still means
    // "nothing was created" and exit 1 always has a run dir with content.
    try {
      await unlink(current).catch(() => undefined);
      await symlink(runDir, current);
    } catch (error) {
      await rm(runDir, { recursive: true, force: true });
      throw new Refused(`could not point ${current} at the run dir: ${String(error)}`);
    }
    await writeFile(resolve(runDir, "PROMPT.md"), args.question, "utf8");
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
    // An operator interrupt surfaces as the first step's `aborted` rejection
    // carrying an operator_signal cause. That is not a failed run.
    if (error instanceof AgentStepFailed && error.abortCause?.kind === "operator_signal") {
      const { signal } = error.abortCause;
      deps.stderr(`INTERRUPTED by ${signal}; every live agent step was stopped and its transcript records it`);
      return signal === "SIGINT" ? 130 : 143;
    }
    if (error instanceof AgentStepFailed) {
      deps.stderr(`FAILED step "${error.step}" completionReason: ${error.completionReason} — ${error.message}`);
    } else if (error instanceof GateFailed) {
      deps.stderr(`FAILED step "${error.step}" completionReason: ${error.completionReason} — ${error.because ?? ""}`);
    } else {
      const reason: CompletionReason = "protocol_error";
      // Covenant 2: a named condition, never a raw stack trace. The stack is
      // available on demand (RESEARCH_DEBUG=1) for the person debugging it.
      const named = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      deps.stderr(`FAILED step "(unknown)" completionReason: ${reason} — ${named}`);
      if (process.env["RESEARCH_DEBUG"] === "1" && error instanceof Error && error.stack) deps.stderr(error.stack);
    }
    return 1;
  }
}

// Entry detection compares REAL paths: a symlinked entrypoint used to make
// `resolve(argv[1])` differ from the module URL and the CLI exited 0 having
// done nothing (ops/DRIVE-LOG.md, the symlink-entrypoint defect).
function isEntrypoint(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  // Operator interrupt. The agents are detached process groups running with
  // their permission prompts bypassed; without this, Ctrl-C would orphan
  // them with no timeout left (the per-step timer lives in this process).
  // The cause reaches every step's transcript marker, and main() reports
  // the run as INTERRUPTED, not FAILED.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stopEverything({ kind: "operator_signal", signal }).then((stopped) => {
        process.stderr.write(`research: ${signal}; stopped ${stopped} agent step(s)\n`);
        // If no run was in progress (e.g. during preflight), nothing else
        // will exit for us.
        if (stopped === 0 && currentAbort === undefined) process.exit(signal === "SIGINT" ? 130 : 143);
      });
    });
  }
  process.exitCode = await main(process.argv.slice(2), {
    runAgent: runAgentWithCli,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
}
