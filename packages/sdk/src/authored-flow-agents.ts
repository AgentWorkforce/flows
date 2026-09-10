import type { AgentOptions, AgentResult } from '@relayflows/surface';
import type { AuthoredFlowDefinition } from '@relayflows/surface/runtime';
import { toKernelSpec } from './compile.js';
import { type CheckReport, type AuthoredFlowChecker } from './cli/check.js';
import { classifyOutcome, type RunLifecycleOptions } from './cli/run.js';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';
import { readSuccessfulAgentOutput, isSurfaceCompletionReason } from './authored-flow-output.js';
import type { AuthoredFlowJournalStep } from './authored-flow-executor.js';
import type { JournalClient } from './journal-client.js';
import { SPEC_SCHEMA_VERSION, type FlowSpec } from './spec.js';

function findRefusalDiagnostic(report: CheckReport) {
  return report.diagnostics.find(diagnostic => diagnostic.severity === 'refusal');
}

export function assertAgentPreflight(report: CheckReport, name: string): void {
  if (report.ok) return;
  const refusal = findRefusalDiagnostic(report);
  throw new AuthoredFlowExecutionError('agent_cli_unresolved',
    refusal?.message ?? `flow "${name}" declares an invalid named agent`,
    undefined, undefined, refusal?.kind ?? 'invalid_spec');
}

/**
 * Matches the `"path/glob: readonly"` / `"path/glob: readwrite"` shorthand
 * shown in docs/SURFACE.md and the examples — the only shape a workspace
 * string could plausibly declare a permission in. No parser anywhere in this
 * package turns that annotation into a real restriction, so `lowerAgent`
 * refuses rather than silently accepting and ignoring it.
 */
const WORKSPACE_PERMISSION_ANNOTATION = /:\s*(readonly|readwrite)\s*$/i;

export function createAgentLowerer<Input>({
  definition, checker, journal, journalSteps, localAgentStream, waitOptions,
}: {
  definition: AuthoredFlowDefinition<Input>;
  checker: AuthoredFlowChecker;
  journal: JournalClient;
  /** Appended only when output reading observes step.completed; never rolled back. */
  journalSteps: AuthoredFlowJournalStep[];
  localAgentStream?: string;
  waitOptions: RunLifecycleOptions;
}) {
  // Matching names select declarations; unmatched names remain step labels and
  // use the project default. Explicit CLI/model overrides win independently.
  const lowerAgent = async (
    id: string,
    name: string,
    options: AgentOptions,
  ): Promise<AgentResult> => {
    if (options.workspace !== undefined && localAgentStream !== undefined) {
      throw new AuthoredFlowExecutionError('unsupported_workspace_permission',
        'The local agent worker accepts stream-only steps. Remove workspace or attach a worker that holds its revision pins.');
    }
    if (options.workspace !== undefined && WORKSPACE_PERMISSION_ANNOTATION.test(options.workspace)) {
      throw new AuthoredFlowExecutionError(
        'unsupported_workspace_permission',
        `flow "${definition.name}" step "${id}": workspace "${options.workspace}" declares a `
          + 'permission annotation ("...: readonly" / "...: readwrite"), but nothing enforces it — '
          + 'no parser anywhere in this package turns that annotation into a real restriction '
          + '(kernel/DAEMON-LIFECYCLE.md\'s permission model is untouched by f.agent). '
          + 'Silently accepting and ignoring it would let a flow believe a restriction is in effect '
          + "when it is not. Declare a bare surface name (no trailing \": readonly\"/\": readwrite\") "
          + 'if you do not need enforcement, or use the declarative spec\'s `permissions` field, which is real.',
      );
    }
    const namedAgents = definition.header.agents;
    const matchesNamedAgent = namedAgents !== undefined
      && Object.hasOwn(namedAgents, name)
      && namedAgents[name] !== undefined;
    const authoring: FlowSpec = {
      version: SPEC_SCHEMA_VERSION,
      name: `${definition.name}/${id}`,
      ...(namedAgents === undefined ? {} : { agents: { ...namedAgents } }),
      steps: [{
        id,
        type: 'agent',
        instruction: options.task,
        ...(localAgentStream === undefined ? {} : {
          surfaces: { streams: [{ stream: localAgentStream }] },
        }),
        ...(matchesNamedAgent ? { agent: name } : {}),
        ...(options.cli === undefined ? {} : { cli: options.cli }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.workspace === undefined ? {} : {
          surfaces: { workspace: [{ surface: options.workspace }] },
        }),
      }],
    };
    // The kernel never resolves a `cli` on its own — every declarative
    // `flows run`/`flows check` binds it first via this exact function
    // (cli/check.ts), searching for the nearest flows.json from `flowPath`
    // and real-probing auth/model readiness. An authored agent step gets
    // nothing for free just because it was declared in TS instead of YAML.
    const { report, flow: resolved } = checker.check(authoring);
    if (!report.ok || resolved === undefined) {
      const refusal = findRefusalDiagnostic(report);
      throw new AuthoredFlowExecutionError(
        'agent_cli_unresolved',
        refusal?.message
          ?? `flow "${definition.name}" step "${id}": no CLI could be resolved for f.agent `
            + `(searched for flows.json from the flow file)`,
        undefined,
        undefined,
        refusal?.kind ?? 'invalid_spec',
      );
    }
    const spec = toKernelSpec(resolved);
    const outcome = await journal.runStart(spec);
    // Reuse the declarative CLI's own wait/classification (cli/run.ts) rather
    // than a hand-rolled poll: `step.completed` and the run's own terminal
    // state are appended as two SEPARATE actions (kernel/relayflowd-core/src/machine.rs
    // completion_actions vs complete_run_actions), so a naive read right
    // after runStart can race a real, valid completion — and a genuinely
    // long-running agent has no reason to be bounded by anything other than
    // its own worker's lease, which classifyOutcome already follows
    // (renewing as the lease renews, per docs/SURFACE.md §5's WAITING
    // [worker_lease] contract), never an unrelated fixed deadline.
    const execution = await classifyOutcome(journal, 'run', outcome, report, '', waitOptions);
    // Preflight refusals (CLI exit 2) happen above, before runStart. Runtime
    // classification returns success (0), failure (1), or parked (3). Keep
    // the nonzero guard fail-closed if that classifier's contract expands.
    if (execution.exitCode === 3) {
      const parked = execution.report.parkedStep;
      throw new AuthoredFlowExecutionError(
        'agent_parked',
        [...execution.report.diagnostics].reverse().find(d => d.severity === 'parked')?.message
          ?? `flow "${definition.name}" step "${id}" parked`
            + (parked !== undefined ? ` (${parked.type})` : '')
            + ': no worker is attached to run it.',
        undefined,
        outcome.run_id,
      );
    }
    if (execution.exitCode !== 0) {
      const reason = execution.report.completionReason;
      throw new AuthoredFlowExecutionError(
        'step_failed',
        [...execution.report.diagnostics].reverse().find(d => d.severity === 'failure' || d.severity === 'refusal')?.message
          ?? `flow "${definition.name}" step "${id}" did not complete successfully `
            + `(status: ${execution.report.status ?? 'unknown'})`,
        isSurfaceCompletionReason(reason) ? reason : undefined,
        outcome.run_id,
      );
    }
    return readSuccessfulAgentOutput(journal, outcome.run_id, id, journalSteps);
  };

  return lowerAgent;
}
