// compliance-flow.ts — arm B, a v2 relayflow (docs/SURFACE.md dialect).
//
// One agent step does the task, given ONLY TASK.md's bare brief — no
// mention of test-first, debug leftovers, secrets, or commit format. That
// is the same brief arm A's agent gets (see ../shims/run-agent-trial.ts);
// this flow never installs SKILL.md as a project skill either. Four
// deterministic steps then gate on exactly the same checks/*.sh scripts
// arm A is scored against after the fact — the SAME scripts, not a second
// hand-written copy of the same four rules. The difference from arm A is
// not the rules; it is where they live: here they are postfix gates a run
// cannot complete without passing, not a skill the agent is trusted to
// remember on its own.
//
// One bounded retry (RFC-0001 §1: "semantic retry — verification gates +
// bounded iteration, because an agent's failure mode is wrong output, not
// no output"): if any gate fails on the first pass, the agent gets exactly
// one more turn with the failing gates' own messages as feedback, then the
// same four gates run again. A second failure ends the run `gate_failed`,
// naming every rule still broken — never a silent success, and never an
// unbounded retry loop either.
//
// STATUS: written in the v2 dialect (docs/SURFACE.md), the same way
// examples/research/research.flow.ts is: it declares the narrow slice of
// the surface this task needs (an `agent` verb and a `check` verb, the
// latter a named deterministic step rather than a raw `run` string) as
// local types, and shims/run-flow.ts provides that slice on today's
// runtime. Executed by shims/run-flow.ts, which implements postfix
// `.gate()` in userland exactly the way examples/research/shims/run.ts
// already does for its own context — the real authored executor throws
// `unsupported_gate` today (packages/sdk/src/authored-flow-operation.ts),
// so this is the same documented gap, not a second one.

import { CHECK_NAMES, type CheckName } from "./shims/trial-runtime.ts";

export { CHECK_NAMES };
export type { CheckName };

export interface ComplianceInput {
  /** Absolute path to the isolated git repo the agent works in. */
  repoDir: string;
  /** TASK.md's content, verbatim — identical to what arm A's agent receives. */
  task: string;
}

export interface Step<T> extends PromiseLike<T> {
  /** Fails the step with `gate_failed` when the predicate is false. */
  gate(predicate: (value: T) => boolean, because?: string): Step<T>;
}

export interface ImplementResult {
  summary: string;
}

export interface CheckStepResult {
  name: CheckName;
  pass: boolean;
  message: string;
}

export const COMPLETION_REASONS = ["success", "gate_failed", "worker_error"] as const;
export type CompletionReason = (typeof COMPLETION_REASONS)[number];

export interface ComplianceResult {
  completionReason: Extract<CompletionReason, "success">;
  checks: CheckStepResult[];
  attempts: number;
  /** Every attempt's check results, in order — so a run that needed the
   *  retry still shows, in its own evidence, exactly what the FIRST
   *  attempt got wrong, not just that a retry happened. */
  attemptHistory: CheckStepResult[][];
}

export interface ComplianceFlowContext {
  agent(name: "implementer", options: { task: string }): Step<ImplementResult>;
  /** Runs one of checks/<name>.sh against the declared repoDir. */
  check(name: CheckName): Step<CheckStepResult>;
  done(
    reason: "success",
    details: { checks: CheckStepResult[]; attempts: number; attemptHistory: CheckStepResult[][] },
  ): ComplianceResult;
}

export interface ComplianceFlowHeader {
  agents: { implementer: { cli: "claude" } };
}

export interface ComplianceFlowDefinition {
  name: string;
  header: ComplianceFlowHeader;
  run(context: ComplianceFlowContext, input: ComplianceInput): Promise<ComplianceResult>;
}

function flow(
  name: string,
  header: ComplianceFlowHeader,
  run: ComplianceFlowDefinition["run"],
): ComplianceFlowDefinition {
  return { name, header, run };
}

function failingNames(checks: CheckStepResult[]): CheckName[] {
  return checks.filter((c) => !c.pass).map((c) => c.name);
}

function repairBrief(task: string, checks: CheckStepResult[]): string {
  const failures = checks
    .filter((c) => !c.pass)
    .map((c) => `- ${c.name}: ${c.message}`)
    .join("\n");
  return (
    `Your previous change did not pass review. Fix these specific problems ` +
    `without reverting the parts that already work:\n\n${failures}\n\n` +
    `Original task, for context:\n\n${task}`
  );
}

/** Runs all four checks and returns every result, pass or fail. Not gated
 *  individually with postfix `.gate()`: the retry decision below needs to
 *  see ALL FOUR outcomes at once (which rules broke, not just the first),
 *  so the fail-closed decision is made once, in aggregate, after both
 *  attempts — by throwing GateFailed, never by returning a "success" that
 *  quietly omits what failed. `Step<T>.gate()` remains part of the context
 *  contract for callers that want a single step's immediate pass/fail
 *  (research.flow.ts uses exactly that shape); this flow's gate is the
 *  aggregate one below because its retry needs the aggregate view. */
async function runAllChecks(f: ComplianceFlowContext): Promise<CheckStepResult[]> {
  const results: CheckStepResult[] = [];
  for (const name of CHECK_NAMES) {
    results.push(await f.check(name));
  }
  return results;
}

export default flow(
  "skill-vs-flow-compliance",
  { agents: { implementer: { cli: "claude" } } },
  async (f, input) => {
    await f.agent("implementer", { task: input.task });

    const attemptHistory: CheckStepResult[][] = [];
    let checks = await runAllChecks(f);
    attemptHistory.push(checks);
    let attempts = 1;

    if (failingNames(checks).length > 0) {
      attempts = 2;
      await f.agent("implementer", { task: repairBrief(input.task, checks) });
      checks = await runAllChecks(f);
      attemptHistory.push(checks);
    }

    // The gate: a run cannot reach f.done("success") while any check still
    // fails after the bounded retry. This is what arm A has no equivalent
    // of — nothing there can refuse to call the task finished.
    const stillFailing = failingNames(checks);
    if (stillFailing.length > 0) {
      throw new GateFailed(stillFailing, checks, attemptHistory);
    }

    return f.done("success", { checks, attempts, attemptHistory });
  },
);

export class GateFailed extends Error {
  readonly completionReason: Extract<CompletionReason, "gate_failed"> = "gate_failed";
  readonly failedChecks: CheckName[];
  readonly checks: CheckStepResult[];
  readonly attemptHistory: CheckStepResult[][];
  constructor(failedChecks: CheckName[], checks: CheckStepResult[], attemptHistory: CheckStepResult[][]) {
    super(`gate_failed: ${failedChecks.join(", ")} still failing after the bounded retry`);
    this.failedChecks = failedChecks;
    this.checks = checks;
    this.attemptHistory = attemptHistory;
  }
}
