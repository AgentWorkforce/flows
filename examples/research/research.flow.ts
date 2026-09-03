// research — a flows v2 relayflow (docs/SURFACE.md dialect).
//
// Fan one research question out to three independent model lanes — Claude,
// Codex, Grok — each running two subagents (landscape + applied), then have a
// synthesizer agent merge the three reports into one. Each lane is an `agent`
// step (RFC-0001 rung 3); the fan-out is plain `Promise.all`, which is how the
// v2 dialect expresses independent steps. Gates are postfix on the step they
// guard (SURFACE.md §2 law 2) and fail closed: a lane that does not write its
// report fails the run before synthesis is attempted.
//
// This file follows the sales-harness precedent (the sibling repository
// `AgentWorkforce/sales`, checked out beside this one as ../sales; see
// sales/harness/flows/listen.flow.ts there):
// it declares the NARROW slice of the v2 surface it needs, and `shims/`
// provide that slice on today's runtime. When `@relayflows/surface` ships,
// the types below collapse into an import and the body stays as written.
//
// Surface gaps this flow needs closed (mirrors regressions/MANIFEST.json):
//   - flow input: a directly-run flow receives caller input (here the
//     question and run directory). SURFACE.md only shows `on(trigger, (f,
//     event))`; a direct-run `run(f, input)` is the same shape without a
//     trigger.
//   - `agents:` header with `model`: SURFACE.md law 6 shows `{ cli, memory,
//     tools, workspace }`; the SDK's AgentStepSpec already carries `model`.
//     The shim passes it on the CLI's own model flag (that is what selects
//     the model) and also exports RELAYFLOW_MODEL for wrappers that read it.
//   - parallel dispatch: the kernel today starts runnable steps one at a
//     time. The shim runs the three lanes concurrently; the flow is written
//     so nothing changes when the kernel does the same.
//   - diff: RFC-0001 says an agent step yields artifact + diff + trajectory.
//     This flow has artifacts (top-level files written) and a trajectory
//     (the CLI's event stream) but no diff; the shim has no workspace
//     revision to diff against. The diff arrives with the kernel's pinned
//     workspace revisions (Appendix A), not with a shim.

import { laneBrief, synthesisBrief } from "./briefs.ts";

export type Lane = "claude" | "codex" | "grok";
export const LANES: readonly Lane[] = ["claude", "codex", "grok"];

/** Names an agent step may resolve to — the three lanes plus the synthesizer. */
export type AgentName = Lane | "synthesizer";

export interface AgentDefinition {
  cli: string;
  /** Surfaced to the CLI as RELAYFLOW_MODEL so the choice is journaled. */
  model?: string;
}

export interface ResearchInput {
  /** The research question, verbatim from the caller. */
  question: string;
  /** Absolute directory the lanes write into; one per run. */
  runDir: string;
}

/** Token usage for one agent step — its budget line (RFC-0001 decision 10). */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Decimal string; absent when the CLI does not report cost. */
  costUsd?: string;
}

/** What an agent step yields (RFC-0001: artifact + diff + trajectory). */
export interface AgentResult {
  /** The agent's final message, read from its structured headless output. */
  summary: string;
  /** Absolute paths of top-level files the agent created or changed in its workspace. */
  artifacts: string[];
  /** The step's budget line. Optional on the type; the flow gates on its presence. */
  usage?: AgentUsage;
  /** Recorded so the adapter reports what the CLI said; nothing in this flow
   *  reads sessionId or subagents yet. They are evidence for a human (and the
   *  adapter tests), not surface the kernel maps today. */
  sessionId?: string;
  subagents?: unknown;
  /** Path to the structured event stream the CLI emitted (JSONL). */
  trajectory?: string;
}

export interface Step<T> extends PromiseLike<T> {
  /** Fails the step with `gate_failed` when the predicate is false. */
  gate(predicate: (value: T) => boolean, because?: string): Step<T>;
}

/** The closed set of ways a run can end. Every failure class the shim
 *  produces types its completionReason from this, and
 *  tests/research.test.ts asserts the set is exactly the one the README
 *  documents, so adding a reason without updating both fails a test. */
export const COMPLETION_REASONS = ["synthesized", "worker_error", "timeout", "aborted", "gate_failed", "protocol_error"] as const;
export type CompletionReason = (typeof COMPLETION_REASONS)[number];

export interface ResearchResult {
  completionReason: Extract<CompletionReason, "synthesized">;
  synthesis: string;
  reports: Record<Lane, string>;
  /** Per-step budget lines, so the run's spend has one owner per token. */
  usage: Partial<Record<AgentName, AgentUsage>>;
}

export interface ResearchFlowContext {
  agent(
    name: AgentName,
    options: { task: string; workspace: string },
  ): Step<AgentResult>;
  done(
    reason: "synthesized",
    details: { synthesis: string; reports: Record<Lane, string>; usage: ResearchResult["usage"] },
  ): ResearchResult;
}

export interface ResearchFlowHeader {
  agents: Record<AgentName, AgentDefinition>;
  budget: string;
}

export interface ResearchFlowDefinition {
  name: string;
  header: ResearchFlowHeader;
  run(context: ResearchFlowContext, input: ResearchInput): Promise<ResearchResult>;
}

function flow(
  name: string,
  header: ResearchFlowHeader,
  run: ResearchFlowDefinition["run"],
): ResearchFlowDefinition {
  return { name, header, run };
}

/** Each lane owns its own workspace under the run dir, so a lane's artifacts
 *  are the files IT wrote — not whatever a sibling lane wrote concurrently. */
export function laneWorkspace(runDir: string, lane: Lane): string {
  return `${runDir}/${lane}`;
}

export function reportPath(runDir: string, lane: Lane): string {
  return `${laneWorkspace(runDir, lane)}/report.md`;
}

export function synthesisPath(runDir: string): string {
  return `${runDir}/SYNTHESIS.md`;
}

export default flow(
  "research",
  {
    // Every agent DECLARES its model (the precedent is 51415d9: a model
    // inherited from the host is not recoverable from the journal and has
    // broken runs before). Preflight verifies each (cli, model) pair live.
    agents: {
      claude: { cli: "claude", model: "sonnet" },
      codex: { cli: "codex", model: "gpt-5.6-sol" },
      grok: { cli: "grok", model: "grok-4.6" },
      synthesizer: { cli: "claude", model: "opus" },
    },
    budget: "$15/run",
  },
  async (f, input) => {
    // Fan-out. Every lane is independent, so all three are dispatched at
    // once; the run waits for all of them. A lane that exits without its
    // report fails its own gate, and Promise.all fails the run with it.
    // Each lane's result is tagged with its own name, so nothing downstream
    // depends on the order Promise.all happens to return in.
    const reports = await Promise.all(
      LANES.map(async (lane) => ({
        lane,
        result: await f
          .agent(lane, {
            task: laneBrief(lane, input.question, reportPath(input.runDir, lane)),
            workspace: `${laneWorkspace(input.runDir, lane)}: readwrite`,
          })
          .gate(
            (r) => r.artifacts.includes(reportPath(input.runDir, lane)),
            `lane ${lane} must write its report to ${reportPath(input.runDir, lane)}`,
          )
          .gate((r) => r.usage !== undefined, `lane ${lane} must report its token usage`),
      })),
    );

    const reportByLane = Object.fromEntries(
      LANES.map((lane) => [lane, reportPath(input.runDir, lane)]),
    ) as Record<Lane, string>;

    // Fan-in. The synthesizer's workspace is the run dir, which contains the
    // three lane workspaces; the flow hands it paths, never contents, so the
    // step's budget is charged to the step that spends it (RFC-0001
    // decision 10).
    const synthesis = await f
      .agent("synthesizer", {
        task: synthesisBrief(input.question, reportByLane, synthesisPath(input.runDir)),
        workspace: `${input.runDir}: readwrite`,
      })
      .gate(
        (r) => r.artifacts.includes(synthesisPath(input.runDir)),
        `synthesis must be written to ${synthesisPath(input.runDir)}`,
      )
      .gate((r) => r.usage !== undefined, "synthesis must report its token usage");

    // The report paths are the durable record; the step results contribute
    // only their budget lines to the run's result.
    // The usage gates above guarantee every result carries usage.
    const usage: ResearchResult["usage"] = Object.fromEntries(
      reports.map(({ lane, result }) => [lane, result.usage]),
    ) as ResearchResult["usage"];
    usage.synthesizer = synthesis.usage;
    return f.done("synthesized", {
      synthesis: synthesisPath(input.runDir),
      reports: reportByLane,
      usage,
    });
  },
);
