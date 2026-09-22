import { resolve } from 'node:path';
import type { AuthoredBudget } from './authored-budget.js';
import { parseBudget } from './budget.js';
import type { AgentOptions, AgentResult, LlmOptions, NamedGate } from '@relayflows/surface';
import { compileSpec, toKernelSpec } from './compile.js';
import { checkAuthoredFlow } from './cli/check.js';
import { classifyOutcome, type RunLifecycleOptions, type RunReport } from './cli/run.js';
import type { PreflightDiagnostic } from './preflight.js';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';
import type { JournalClient } from './journal-client.js';
import { SPEC_SCHEMA_VERSION, type FlowSpec, type PermissionsSpec, type StepSpec } from './spec.js';
import { isSurfaceCompletionReason, readCompletedStepOutput, readSuccessfulOutput, type AuthoredStepContext } from './authored-step-output.js';
import type { AuthoredFlowJournalStep } from './authored-flow-executor.js';
import { snapshotJsonValue } from './json-value.js';
import { authoredChildAdmissionKey } from './authored-admission.js';
import { alsoRecord, recordAuthoredChild } from './authored-step-index.js';
import type { StepFailedDetails } from './failure-kinds.js';
import { WorkerSlots } from './worker-slots.js';

const WORKSPACE_PERMISSION_ANNOTATION = /:\s*(readonly|readwrite)\s*$/i;

/** Agent and LLM calls share the exact declarative preflight and lease wait. */
export function authoredWorkerRunner(
  definition: { name: string }, journal: JournalClient, flowPath: string,
  journalSteps: AuthoredFlowJournalStep[], waitOptions: RunLifecycleOptions,
  localAgentStream?: string, budget?: AuthoredBudget, headerBudget?: unknown,
  rootRunId?: string, workerCapacity?: number,
) {
  // Sized to the attached local workers, so concurrent calls wait here for a
  // slot instead of being admitted and parked for want of a free worker.
  const slots = workerCapacity === undefined ? undefined
    : { agent: new WorkerSlots(workerCapacity), llm: new WorkerSlots(workerCapacity) };
  const context: AuthoredStepContext = {
    ...(rootRunId === undefined ? {} : { rootRunId }),
    ...(waitOptions.dataDir === undefined ? {} : { dataDir: waitOptions.dataDir }),
  };
  async function run(step: StepSpec): Promise<unknown> {
    const id = step.id;
    const authoring: FlowSpec = { version: SPEC_SCHEMA_VERSION, name: `${definition.name}/${id}`, steps: [step], ...(headerBudget === undefined ? {} : { budget: parseBudget(headerBudget) }) };
    // The kernel never resolves a `cli` on its own — every declarative
    // `flows run`/`flows check` binds it first via this exact function
    // (cli/check.ts), searching for the nearest flows.json from `flowPath`
    // and real-probing auth/model readiness. An authored agent step gets
    // nothing for free just because it was declared in TS instead of YAML.
    const { report, flow: resolved } = checkAuthoredFlow(authoring, flowPath);
    if (!report.ok || resolved === undefined) {
      const refusal = report.diagnostics.find(
        (diagnostic): diagnostic is PreflightDiagnostic & { severity: 'refusal' } =>
          diagnostic.severity === 'refusal',
      );
      throw new AuthoredFlowExecutionError(
        refusal?.kind === 'budget_syntax_invalid' ? refusal.kind
          : step.type === 'llm' ? 'llm_cli_unresolved' : 'agent_cli_unresolved',
        refusal?.message
          ?? `flow "${definition.name}" step "${id}": no CLI could be resolved for f.${step.type} `
            + `(searched for flows.json from "${flowPath}")`,
      );
    }
    const spec = toKernelSpec(resolved);
    const consume = async (outcome: import('./protocol.js').RunOutcome) => {
    // Written BEFORE the wait, not after it. An agent runs for as long as its
    // lease allows; if this process dies mid-step, this record is the only
    // thing that still names the child run holding the evidence.
    await recordAuthoredChild(journal, rootRunId, { step: id, runId: outcome.run_id, state: 'admitted' });
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
    if (execution.exitCode === 3) {
      const parked = execution.report.parkedStep;
      throw new AuthoredFlowExecutionError(
        step.type === 'llm' ? 'llm_parked' : 'agent_parked',
        execution.report.diagnostics.at(-1)?.message
          ?? `flow "${definition.name}" step "${id}" parked`
            + (parked !== undefined ? ` (${parked.type})` : '')
            + ': no worker is attached to run it.',
        undefined,
        outcome.run_id,
      );
    }
    if (execution.exitCode !== 0) {
      // `execution.report.completionReason` is the RUN's reason (normally
      // `step_failed`), not the step's. The step's terminal facts are the
      // ones `classifyOutcome` already extracted with `stepFailureDetails`
      // and assigned onto this diagnostic — read them from there rather than
      // re-walking the journal or mislabelling the run reason as a step one.
      const diagnostic = execution.report.diagnostics.at(-1);
      const details = stepDetails(diagnostic);
      const reason = execution.report.completionReason;
      let message = diagnostic?.message
        ?? `flow "${definition.name}" step "${id}" did not complete successfully `
          + `(status: ${execution.report.status ?? 'unknown'})`;
      // Only a reason the journal actually recorded for a step is indexed;
      // an unfinished or unreadable child is left as `admitted`, never given
      // a manufactured completion.
      if (isSurfaceCompletionReason(details?.completionReason)) {
        journalSteps.push(Object.freeze({
          id, runId: outcome.run_id, completionReason: details.completionReason,
        }));
        message += await alsoRecord(journal, rootRunId, {
          step: id, runId: outcome.run_id, state: 'completed',
          completionReason: details.completionReason,
          ...(details.stepId === undefined ? {} : { kernelStep: details.stepId }),
        });
      }
      throw new AuthoredFlowExecutionError(
        'step_failed', message,
        isSurfaceCompletionReason(reason) ? reason : undefined,
        outcome.run_id,
        details,
      );
    }
    return readCompletedStepOutput(journal, outcome.run_id, id, journalSteps, context);
    };
    const admissionKey = authoredChildAdmissionKey(rootRunId, id);
    const admit = async () => budget === undefined
      ? consume(await journal.runStart(spec, undefined, admissionKey))
      : budget.execute(journal, spec, consume, admissionKey);
    return slots === undefined ? admit() : slots[step.type === 'llm' ? 'llm' : 'agent'].run(admit);
  }

  return {
    async agent(id: string, options: AgentOptions, verification?: NamedGate): Promise<AgentResult> {
      if (options.workspace !== undefined && localAgentStream !== undefined) {
        throw new AuthoredFlowExecutionError('unsupported_workspace_permission',
          'The local agent worker accepts stream-only steps. Remove workspace or attach a worker that holds its revision pins.');
      }
      if (options.workspace !== undefined && WORKSPACE_PERMISSION_ANNOTATION.test(options.workspace)) {
        throw new AuthoredFlowExecutionError(
          'unsupported_workspace_permission',
          `flow "${definition.name}" step "${id}": workspace "${options.workspace}": `
            + "Workspace permission suffixes are unsupported. Use a bare workspace name and f.agent's "
            + "permissions option, for example permissions: { fileGlobs: ['src/**'], accessPreset: 'readonly' }. "
            + 'This declaration is validated and recorded with the step spec; it is not currently enforced (gate 8 / #442).',
        );
      }
      if (options.cli !== undefined && typeof options.cli !== 'string') {
        throw new AuthoredFlowExecutionError(
          'agent_cli_unresolved',
          `f.agent options.cli must be a string when set (got ${typeof options.cli}).`,
        );
      }
      if (options.model !== undefined && typeof options.model !== 'string') {
        throw new AuthoredFlowExecutionError(
          'agent_cli_unresolved',
          `f.agent options.model must be a string when set (got ${typeof options.model}).`,
        );
      }
      if (options.cwd !== undefined && typeof options.cwd !== 'string') {
        throw new AuthoredFlowExecutionError(
          'agent_cli_unresolved',
          `f.agent options.cwd must be a string when set (got ${typeof options.cwd}).`,
        );
      }
      if (options.transport !== undefined && options.transport !== 'direct' && options.transport !== 'relay') {
        throw new AuthoredFlowExecutionError(
          'agent_cli_unresolved',
          `f.agent options.transport must be 'direct' or 'relay' (got ${JSON.stringify(options.transport)}).`,
        );
      }
      const permissions = options.permissions;
      const permissionsSnapshot = permissions === undefined ? undefined
        : snapshotJsonValue(permissions, 'f.agent options.permissions') as unknown as PermissionsSpec;
      const output = await run({
        id, type: 'agent', instruction: options.task,
        ...(permissionsSnapshot === undefined ? {} : { permissions: permissionsSnapshot }),
        ...(localAgentStream === undefined ? {} : { surfaces: { streams: [{ stream: localAgentStream }] } }),
        ...(options.workspace === undefined ? {} : { surfaces: { workspace: [{ surface: options.workspace }] } }),
        ...(options.cli === undefined ? {} : { cli: options.cli }),
        ...(options.model === undefined ? {} : { model: options.model }),
        // The kernel takes only an absolute cwd; a relative one means the runner's own directory.
        ...(options.cwd === undefined ? {} : { cwd: resolve(options.cwd) }),
        ...(options.transport === undefined ? {} : { transport: options.transport }),
        ...(verification === undefined ? {} : { verification }),
      });
      if (typeof output !== 'object' || output === null || Array.isArray(output)) {
        throw new AuthoredFlowExecutionError('journal_protocol_violation', `step "${id}" produced a non-object output`);
      }
      const stdout = 'stdout_tail' in output ? output.stdout_tail : undefined;
      // The worker that ran the CLI measured the artifacts and journaled them
      // in the step's output; read that fact back rather than re-scanning a
      // directory this process may not even share with the agent.
      const journaled = 'artifacts' in output ? output.artifacts : undefined;
      const artifacts = Array.isArray(journaled) && journaled.every(entry => typeof entry === 'string')
        ? [...journaled] : [];
      return { summary: typeof stdout === 'string' ? stdout : JSON.stringify(output), artifacts };
    },
    async llm(id: string, prompt: string, options?: LlmOptions, verification?: NamedGate): Promise<unknown> {
      if (options !== undefined && (typeof options !== 'object' || options === null || options.output === undefined)) {
        throw new AuthoredFlowExecutionError('llm_cli_unresolved', 'f.llm(prompt, options) requires an output JSON Schema.');
      }
      const snapshot = options === undefined ? undefined : snapshotJsonValue(options, 'f.llm options');
      if (snapshot !== undefined && (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)
        || Object.keys(snapshot).some(key => !['output', 'cli', 'model'].includes(key)))) {
        throw new AuthoredFlowExecutionError('llm_cli_unresolved', 'f.llm options accepts only output, cli, and model.');
      }
      const output = await run({
        id, type: 'llm', prompt, ...snapshot as unknown as LlmOptions,
        ...(verification === undefined ? {} : { verification }),
      });
      if (options === undefined && typeof output !== 'string') {
        throw new AuthoredFlowExecutionError('journal_protocol_violation', `text step "${id}" produced a non-string output`);
      }
      return output;
    },
  };
}

/**
 * Deterministic commands execute inline under their per-invocation lease.
 *
 * `context` carries the root run (so each child is indexed on it) and the
 * data dir (so a failure can name the journal on disk). It is the same object
 * the worker runner builds; a failed `f.run` and a failed `f.agent` now report
 * through one grammar.
 */
export function authoredDeterministicRunner(
  name: string, journal: JournalClient, journalSteps: AuthoredFlowJournalStep[], budget: AuthoredBudget,
  context: AuthoredStepContext = {},
) {
  const rootRunId = context.rootRunId;
  return async (id: string, command: string, terminal = false, leaseMs?: number, verification?: NamedGate): Promise<string> => {
    const spec = toKernelSpec(compileSpec({
      version: SPEC_SCHEMA_VERSION,
      name: `${name}/${id}`,
      steps: [{
        id, type: 'deterministic', command,
        ...(leaseMs === undefined ? {} : { lease_ms: leaseMs }),
        ...(verification === undefined ? {} : { verification }),
      }],
    }));
    const admissionKey = authoredChildAdmissionKey(rootRunId, id);
    const consume = async (outcome: import('./protocol.js').RunOutcome): Promise<string> => {
      await recordAuthoredChild(journal, rootRunId, { step: id, runId: outcome.run_id, state: 'admitted' });
      return readSuccessfulOutput(journal, outcome, id, journalSteps, context);
    };
    if (terminal) return consume(await journal.runStart(spec, undefined, admissionKey));
    return budget.execute(journal, spec, consume, admissionKey);
  };
}

/**
 * Lift the step-shaped fields off a run diagnostic.
 *
 * `RunDiagnostic extends StepFailedDetails`, so `classifyOutcome`'s
 * `Object.assign(diagnostic, details)` leaves the extraction right there. The
 * fields are picked explicitly rather than spread, so `severity`, `kind` and
 * `message` — which describe the RUN, not the step — cannot leak into
 * something typed as the step's evidence.
 */
function stepDetails(
  diagnostic: RunReport['diagnostics'][number] | undefined,
): StepFailedDetails | undefined {
  if (diagnostic === undefined) return undefined;
  // `RunDiagnostic` is the only member of this union that extends
  // `StepFailedDetails`; the check-report shapes carry none of these fields,
  // so reading them as optionals yields `undefined` and contributes nothing.
  const found = diagnostic as Partial<StepFailedDetails>;
  const details: StepFailedDetails = {
    ...(found.stepId === undefined ? {} : { stepId: found.stepId }),
    ...(found.stepType === undefined ? {} : { stepType: found.stepType }),
    ...(found.completionReason === undefined ? {} : { completionReason: found.completionReason }),
    ...(found.attempt === undefined ? {} : { attempt: found.attempt }),
    ...(found.maxIterations === undefined ? {} : { maxIterations: found.maxIterations }),
    ...(found.exitCode === undefined ? {} : { exitCode: found.exitCode }),
    ...(found.stdoutTail === undefined ? {} : { stdoutTail: found.stdoutTail }),
    ...(found.stderrTail === undefined ? {} : { stderrTail: found.stderrTail }),
    ...(found.detail === undefined ? {} : { detail: found.detail }),
    ...(found.transcriptPath === undefined ? {} : { transcriptPath: found.transcriptPath }),
    ...(found.hint === undefined ? {} : { hint: found.hint }),
    ...(found.journalPath === undefined ? {} : { journalPath: found.journalPath }),
  };
  return Object.keys(details).length === 0 ? undefined : details;
}
