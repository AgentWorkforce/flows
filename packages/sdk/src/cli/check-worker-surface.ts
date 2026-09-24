import { compileSpec } from '../compile.js';
import type { FlowSpec } from '../spec.js';
import type { CheckWarningDiagnostic } from './check.js';

/** Enough ids to recognise the flow, not enough to bury the remedy. */
const NAMED_STEP_LIMIT = 3;

/**
 * `agent` steps need a worker attached for step type `agent`, and nothing in a
 * spec says whether one will be. `flows run` attaches the SDK's `AgentWorker`
 * only under `--local-agent` (`cli/run.ts`); with no worker the run parks at
 * the first agent step with `no worker is attached for step type "agent"`.
 * `flows check` already walks these steps to print its `REQUIRES` line, so the
 * fact is in hand — this spends it.
 *
 * Warning, never a refusal, and worded as a requirement rather than a
 * prediction: worker attachment is *unknown* here, not absent. A worker can be
 * attached out of band (an SDK `AgentWorker` against the same daemon, Cloud's
 * workers for a hosted run), and `flows check` is daemon-free by construction,
 * so it cannot see one either way.
 *
 * Scoped to `agent` steps. `--local-agent` attaches no `llm` worker on the
 * YAML path, so naming it for `llm` steps would be false; those steps are not
 * counted and not mentioned.
 *
 * Blind spot, shared with `permissions_unenforced`: an authored `.flow.ts`
 * flow is checked through `checkMcpHeader`, which preflights a synthetic
 * one-step header spec without executing the body. There are no compiled
 * `agent` steps to count, so this diagnostic is silent for `.flow.ts`.
 */
export function agentWorkerDiagnostics(authoring: FlowSpec): CheckWarningDiagnostic[] {
  const steps = agentStepIds(authoring);
  if (steps.length === 0) return [];
  return [{ severity: 'warning', kind: 'agent_worker_unresolved', message: message(steps) }];
}

/**
 * Compiled `agent` steps, by id. Compilation is the only walk that sees them
 * all: a YAML helper step (`slack: { post: … }`) is an `agent` step carrying a
 * helper envelope and needs the same SDK agent worker, and only the compiler
 * lowers it into one. `requirements.harnesses` is the wrong source — it
 * deduplicates by harness, counts `llm` use, and omits helper steps entirely.
 *
 * A spec that does not compile yields no diagnostic rather than a thrown
 * check: the compile refusal is owned by the existing preflight path and is
 * the whole report in that case.
 */
function agentStepIds(authoring: FlowSpec): string[] {
  try {
    return compileSpec(authoring).steps.filter((step) => step.type === 'agent').map((step) => step.id);
  } catch {
    return [];
  }
}

function message(steps: readonly string[]): string {
  const named = steps.slice(0, NAMED_STEP_LIMIT).map((id) => `"${id}"`).join(', ');
  const rest = steps.length - NAMED_STEP_LIMIT;
  const list = rest > 0 ? `${named} and ${rest} more` : named;
  const subject = steps.length === 1
    ? `1 agent step (${list}) requires`
    : `${steps.length} agent steps (${list}) require`;
  return `${subject} an attached worker. For a local run, use \`flows run --local-agent <flow>\`, `
    + 'unless you already attach an agent worker for this daemon. `flows check` does not verify worker '
    + 'attachment: with no worker attached the run parks at the first agent step.';
}
