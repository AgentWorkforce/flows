// Illustrative v2-style flow, executed by the local userland shim.
// The initial prompt is shared across arms. Four deterministic final-state
// checks run after the agent; their failure messages drive one repair turn.
// These are proxies for parts of SKILL.md, not proof of test-first ordering.
// A second failing check set throws GateFailed and never calls done(success).
// This local contract does not demonstrate journal execution or durability.

import { CHECK_NAMES, type CheckName } from "./shims/trial-runtime.ts";

export { CHECK_NAMES };
export type { CheckName };

export interface ComplianceInput {
  /** Absolute path to the isolated git repo the agent works in. */
  repoDir: string;
  /** Selected task text, before any optional skill-discovery nudge. */
  task: string;
}

// Ordinary local async values: no journal handles, memoization or durable
// step boundaries are implied by this presentation type.
export type Step<T> = PromiseLike<T>;

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
  /** Success only. Gate rejection is signaled by throwing GateFailed; the
   * runner catches it and writes the terminal gate_failed verdict. */
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

/** Collects every check outcome so the repair sees all failures. The final
 * aggregate decision throws GateFailed if any check still fails. */
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
