// REPLACE-WHEN: gate-1 agent dispatch accepts a run-time instruction and the
// kernel starts independent steps concurrently. Then `f.agent` is the SDK's
// AgentWorker (packages/sdk/src/worker.ts) and this file is deleted.
//
// What this shim provides today: the `agent` verb of research.flow.ts's
// context, executed by spawning the lane's declared CLI through its headless
// adapter (./headless.ts) — never a raw `-p` whose last line is guessed at.
// It keeps the contracts the real worker has: the declared model is surfaced
// as RELAYFLOW_MODEL and never inherited from the host; a non-zero exit, or
// a zero exit with no readable final message, is a `worker_error` and fails
// the step; the result names the files the agent actually wrote (its
// artifacts), carries its token usage and cost (its budget line), and points
// at the structured event stream written to disk (its trajectory).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import type { AgentDefinition, AgentName, AgentResult, CompletionReason } from "../research.flow.ts";
import {
  headlessInvocation,
  HeadlessParseError,
  isHeadlessCli,
  parseHeadless,
  type HeadlessBinaries,
  type HeadlessCli,
} from "./headless.ts";

export interface AgentRunOptions {
  name: AgentName;
  definition: AgentDefinition;
  task: string;
  /** `<dir>: readwrite` as written in the flow; only the dir is used here. */
  workspace: string;
  /** Working directory for the CLI — the repo root, so lanes can read code. */
  cwd: string;
  timeoutMs: number;
  /** Binary per CLI; defaults to the bare name on PATH. Tests point this at stubs. */
  binaries?: HeadlessBinaries;
  /** Aborted when a sibling step has already failed: a step that has not
   *  spawned yet must not start, and one that has is killed. */
  signal?: AbortSignal;
}

export type AgentRunner = (options: AgentRunOptions) => Promise<AgentResult>;

/** Why a step was aborted. Carried as the AbortSignal's reason so the
 *  transcript marker and the operator-facing report can say which. */
export type AbortCause = { kind: "sibling_failed" } | { kind: "operator_signal"; signal: NodeJS.Signals };

export function describeAbort(cause: unknown): string {
  const c = cause as Partial<AbortCause> | undefined;
  if (c?.kind === "operator_signal") return `stopped by operator ${(c as { signal: string }).signal}`;
  if (c?.kind === "sibling_failed") return "killed because a sibling step failed";
  return "aborted";
}

export class AgentStepFailed extends Error {
  readonly step: AgentName;
  readonly completionReason: Extract<CompletionReason, "worker_error" | "timeout" | "aborted">;
  /** Present when completionReason is "aborted". */
  readonly abortCause?: AbortCause;
  constructor(step: AgentName, completionReason: AgentStepFailed["completionReason"], detail: string, abortCause?: AbortCause) {
    super(`agent step "${step}" failed (${completionReason}): ${detail}`);
    this.step = step;
    this.completionReason = completionReason;
    this.abortCause = abortCause;
  }
}

export const MODEL_ENV = "RELAYFLOW_MODEL";

export function workspaceDir(workspace: string): string {
  const [dir] = workspace.split(":");
  if (!dir || dir.trim() === "") throw new Error(`workspace has no directory: "${workspace}"`);
  const trimmed = dir.trim();
  // The flow's reportPath() concatenates strings and the gate compares them
  // to join()'s normalized output; that equality only holds for an absolute,
  // already-normalized dir. Refuse anything else rather than fail the gate
  // with a confusing "report not written".
  if (!isAbsolute(trimmed) || normalize(trimmed) !== trimmed) {
    throw new Error(`workspace dir must be absolute and normalized: "${trimmed}"`);
  }
  return trimmed;
}

/** Process groups of agents currently running under this process. When one
 *  step fails its gate, Promise.all rejects but the siblings keep running —
 *  and keep spending — until their own timeout. The entry point calls
 *  killLiveAgents() so a failed run stops spending immediately.
 *
 *  MODULE-GLOBAL: one registry per process. Two flows run in one process
 *  would kill each other's agents on failure. run.ts runs exactly one flow
 *  per process, which is the only supported shape of this shim. */
const live = new Map<number, Promise<void>>();
/** Kill every live agent process group and wait until each STEP has fully
 *  settled — child closed, transcript and completionReason marker written —
 *  so a caller that reads or removes the workspace afterwards (a test's
 *  teardown, an operator) never races a dying step. Returns the number of
 *  live steps it stopped. The kill itself may report ESRCH when the abort
 *  signal already killed the group and the child is an unreaped zombie;
 *  that is still a step this call stopped and waited for. */
export async function killLiveAgents(): Promise<number> {
  const pending: Promise<void>[] = [];
  let stopped = 0;
  for (const [pgid, closed] of live) {
    try { process.kill(-pgid, "SIGKILL"); } catch { /* already signalled; still await its close */ }
    stopped += 1;
    pending.push(closed);
  }
  live.clear();
  await Promise.allSettled(pending);
  return stopped;
}

/** Files under `dir` (one level) keyed by path → content signature
 *  (size + sha256). Content, not mtime: a same-size rewrite inside the
 *  filesystem's timestamp resolution must still count as a change. */
async function snapshot(dir: string, skip: ReadonlySet<string>): Promise<Map<string, string>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    // The shim's own prompt/log/trajectory files are never artifacts; do not
    // hash a multi-megabyte transcript only to discard it.
    if (skip.has(path)) continue;
    // A file can vanish between readdir and read (a CLI's temp file); that is
    // not an artifact and must not surface as protocol_error after the
    // tokens were spent.
    const info = await stat(path).catch(() => undefined);
    const bytes = info ? await readFile(path).catch(() => undefined) : undefined;
    if (info && bytes) out.set(path, `${info.size}:${createHash("sha256").update(bytes).digest("hex")}`);
  }
  return out;
}

export const runAgentWithCli: AgentRunner = async (options) => {
  const { cli, model } = options.definition;
  if (!isHeadlessCli(cli)) {
    throw new AgentStepFailed(options.name, "worker_error", `no headless adapter for cli "${cli}"`);
  }
  const dir = workspaceDir(options.workspace);
  await mkdir(dir, { recursive: true });
  const promptFile = join(dir, `${options.name}.prompt.md`);
  const logFile = join(dir, `${options.name}.log`);
  const trajectoryFile = join(dir, `${options.name}.trajectory.jsonl`);
  await writeFile(promptFile, options.task, "utf8");
  const own = new Set([promptFile, logFile, trajectoryFile]);
  const before = await snapshot(dir, own);

  // A sibling may have failed (or the operator interrupted) while this step
  // was still preparing its workspace. Refuse to spawn: the registry can
  // only kill what exists. The transcript still records why.
  if (options.signal?.aborted) {
    const cause = options.signal.reason as AbortCause;
    await recordCompletion(logFile, "aborted", `${describeAbort(cause)}; no CLI was run`);
    throw new AgentStepFailed(options.name, "aborted", `${describeAbort(cause)} before this step started`, cause);
  }
  const { argv, stdin } = headlessInvocation(cli, { model, promptFile, cwd: options.cwd, binaries: options.binaries });
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Same rule as packages/sdk/src/worker.ts: unset first, then set only when declared,
  // so a CLI can tell "no model chosen" from an inherited pin.
  delete env[MODEL_ENV];
  if (model !== undefined) env[MODEL_ENV] = model;

  // The registry entry resolves when THIS STEP has settled (log and marker
  // written), not merely when the child closed.
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((done) => { settle = done; });
  let pid: number | undefined;
  try {
    const result = await spawnCapture(argv, {
      cwd: options.cwd,
      env,
      stdin: stdin === "prompt" ? options.task : undefined,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onSpawn: (childPid) => { pid = childPid; live.set(childPid, settled); },
    });
    return await settleStep({ name: options.name, cli, argv, timeoutMs: options.timeoutMs, dir, own, before, logFile, trajectoryFile }, result);
  } finally {
    if (pid !== undefined) live.delete(pid);
    settle();
  }
};

/** Every step's transcript ends with its completionReason (AGENTS.md rule
 *  4), so a stranger reading a failed run's directory can tell "killed
 *  because a sibling failed", "stopped by the operator", and "the CLI died
 *  on its own" apart without the in-memory error that Promise.all discarded. */
function recordCompletion(logFile: string, reason: CompletionReason | "success", detail: string): Promise<void> {
  return appendFile(logFile, `\n--- completionReason: ${reason} — ${detail}\n`, "utf8");
}

interface StepContext {
  name: AgentName;
  cli: HeadlessCli;
  argv: string[];
  timeoutMs: number;
  dir: string;
  own: ReadonlySet<string>;
  before: Map<string, string>;
  logFile: string;
  trajectoryFile: string;
}

/** Turn a finished process into the step's result: write the transcript,
 *  classify the outcome, record the marker, parse the output, diff the
 *  workspace. Every exit path leaves the marker in the log. */
async function settleStep(ctx: StepContext, { exitCode, timedOut, stdout, stderr, aborted, abortCause }: SpawnResult): Promise<AgentResult> {
  // The raw streams are kept verbatim for a human; the parsed events are the
  // machine-readable trajectory.
  await writeFile(ctx.logFile, `${stdout}\n--- stderr ---\n${stderr}`, "utf8");

  if (aborted) {
    const why = describeAbort(abortCause);
    await recordCompletion(ctx.logFile, "aborted", why);
    throw new AgentStepFailed(ctx.name, "aborted", `${why}; transcript at ${ctx.logFile}`, abortCause);
  }
  if (timedOut) {
    await recordCompletion(ctx.logFile, "timeout", `exceeded ${ctx.timeoutMs}ms`);
    throw new AgentStepFailed(ctx.name, "timeout", `exceeded ${ctx.timeoutMs}ms; transcript at ${ctx.logFile}`);
  }
  if (exitCode !== 0) {
    await recordCompletion(ctx.logFile, "worker_error", `${ctx.argv[0]} exited ${exitCode}`);
    throw new AgentStepFailed(ctx.name, "worker_error", `${ctx.argv[0]} exited ${exitCode}; transcript at ${ctx.logFile}`);
  }

  let parsed;
  try {
    parsed = parseHeadless(ctx.cli, stdout);
  } catch (error) {
    if (error instanceof HeadlessParseError) {
      await recordCompletion(ctx.logFile, "worker_error", error.message);
      throw new AgentStepFailed(ctx.name, "worker_error", `${error.message}; transcript at ${ctx.logFile}`);
    }
    throw error;
  }
  await recordCompletion(ctx.logFile, "success", `${ctx.argv[0]} exited 0 with a readable final message`);
  await writeFile(ctx.trajectoryFile, parsed.events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");

  // Artifacts are TOP-LEVEL files of the workspace dir that are new or
  // changed since the step started. A lane writing report/index.md yields
  // nothing here; the brief names a top-level path for exactly that reason.
  const after = await snapshot(ctx.dir, ctx.own);
  const artifacts = [...after.entries()]
    .filter(([path, signature]) => ctx.before.get(path) !== signature)
    .map(([path]) => path)
    .sort();
  return {
    summary: parsed.finalText,
    artifacts,
    usage: parsed.usage,
    sessionId: parsed.sessionId,
    subagents: parsed.subagents,
    trajectory: ctx.trajectoryFile,
  };
}

interface SpawnResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  abortCause?: AbortCause;
  stdout: string;
  stderr: string;
}

function spawnCapture(
  argv: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdin: string | undefined; timeoutMs: number; signal?: AbortSignal; onSpawn: (pid: number) => void },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const [command, ...args] = argv;
    if (!command) throw new Error("empty argv");
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    // Own process group so a timeout kills the CLI's subagents too, not just
    // the parent (the same reason kernel/relayflowd/src/exec_det.rs does it).
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
    });
    if (child.pid !== undefined) options.onSpawn(child.pid);
    const killGroup = (): void => {
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, options.timeoutMs);
    let aborted = false;
    let abortCause: AbortCause | undefined;
    const onAbort = (): void => { aborted = true; abortCause = options.signal?.reason as AbortCause; killGroup(); };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    const finish = (exitCode: number | null, extraErr = ""): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        timedOut,
        aborted,
        abortCause,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: `${Buffer.concat(err).toString("utf8")}${extraErr}`,
      });
    };
    child.once("error", (error) => finish(null, `\n${error.message}`));
    child.once("close", (code) => finish(code));
    if (options.stdin !== undefined && child.stdin) {
      // A CLI that exits before reading its prompt raises EPIPE on stdin;
      // without a listener that is an unhandled stream error outside the
      // AgentStepFailed taxonomy. The close handler still reports the exit.
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.stdin);
    }
  });
}
