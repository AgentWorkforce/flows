import type { AuthoredBudget } from './authored-budget.js';
import { parseBudget } from './budget.js';
import type { AgentOptions, AgentResult, LlmOptions, NamedGate } from '@relayflows/surface';
import { compileSpec, toKernelSpec } from './compile.js';
import { checkAuthoredFlow } from './cli/check.js';
import { classifyOutcome, type RunLifecycleOptions } from './cli/run.js';
import type { PreflightDiagnostic } from './preflight.js';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';
import type { JournalClient } from './journal-client.js';
import { SPEC_SCHEMA_VERSION, type FlowSpec, type StepSpec } from './spec.js';
import { isSurfaceCompletionReason, readCompletedStepOutput, readSuccessfulOutput } from './authored-step-output.js';
import type { AuthoredFlowJournalStep } from './authored-flow-executor.js';
import { snapshotJsonValue } from './json-value.js';

const WORKSPACE_PERMISSION_ANNOTATION = /:\s*(readonly|readwrite)\s*$/i;

/** Agent and LLM calls share the exact declarative preflight and lease wait. */
export function authoredWorkerRunner(
  definition: { name: string }, journal: JournalClient, flowPath: string,
  journalSteps: AuthoredFlowJournalStep[], waitOptions: RunLifecycleOptions,
  localAgentStream?: string, budget?: AuthoredBudget, headerBudget?: unknown,
) {
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
        refusal?.kind === 'budget_missing_price' || refusal?.kind === 'budget_syntax_invalid' ? refusal.kind
          : step.type === 'llm' ? 'llm_cli_unresolved' : 'agent_cli_unresolved',
        refusal?.message
          ?? `flow "${definition.name}" step "${id}": no CLI could be resolved for f.${step.type} `
            + `(searched for flows.json from "${flowPath}")`,
      );
    }
    const spec = toKernelSpec(resolved);
    const consume = async (outcome: import('./protocol.js').RunOutcome) => {
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
      const reason = execution.report.completionReason;
      throw new AuthoredFlowExecutionError(
        'step_failed',
        execution.report.diagnostics.at(-1)?.message
          ?? `flow "${definition.name}" step "${id}" did not complete successfully `
            + `(status: ${execution.report.status ?? 'unknown'})`,
        isSurfaceCompletionReason(reason) ? reason : undefined,
        outcome.run_id,
      );
    }
    return readCompletedStepOutput(journal, outcome.run_id, id, journalSteps);
    };
    return budget === undefined ? consume(await journal.runStart(spec)) : budget.execute(journal, spec, consume);
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
          `flow "${definition.name}" step "${id}": workspace "${options.workspace}" declares a `
            + 'permission annotation ("...: readonly" / "...: readwrite"), but nothing enforces it — '
            + 'no parser anywhere in this package turns that annotation into a real restriction '
            + '(kernel/DAEMON-LIFECYCLE.md\'s permission model is untouched by f.agent). '
            + 'Silently accepting and ignoring it would let a flow believe a restriction is in effect '
            + "when it is not. Declare a bare surface name (no trailing \": readonly\"/\": readwrite\") "
            + 'if you do not need enforcement, or use the declarative spec\'s `permissions` field, which is real.',
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
      const output = await run({
        id, type: 'agent', instruction: options.task,
        ...(localAgentStream === undefined ? {} : { surfaces: { streams: [{ stream: localAgentStream }] } }),
        ...(options.workspace === undefined ? {} : { surfaces: { workspace: [{ surface: options.workspace }] } }),
        ...(options.cli === undefined ? {} : { cli: options.cli }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.transport === undefined ? {} : { transport: options.transport }),
        ...(verification === undefined ? {} : { verification }),
      });
      if (typeof output !== 'object' || output === null || Array.isArray(output)) {
        throw new AuthoredFlowExecutionError('journal_protocol_violation', `step "${id}" produced a non-object output`);
      }
      const stdout = 'stdout_tail' in output ? output.stdout_tail : undefined;
      return { summary: typeof stdout === 'string' ? stdout : JSON.stringify(output), artifacts: [] };
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

/** Deterministic commands execute inline under their per-invocation lease. */
export function authoredDeterministicRunner(
  name: string, journal: JournalClient, journalSteps: AuthoredFlowJournalStep[], budget: AuthoredBudget,
) {
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
    if (terminal) return readSuccessfulOutput(journal, await journal.runStart(spec), id, journalSteps);
    return budget.execute(journal, spec, outcome => readSuccessfulOutput(journal, outcome, id, journalSteps));
  };
}
