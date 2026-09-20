import { McpStepError } from '../authored-mcp.js';
import { randomUUID } from 'node:crypto';
import { authoredLocalAgentStream } from '../authored-admission.js';
import { McpPreflightError } from './check-typescript.js';
import { attachLocalAgent } from '../local-agent.js';
import { LlmWorker } from '../llm-worker.js';
import {
  AuthoredFlowExecutionError,
} from '../authored-flow-executor.js';
import { executeDurableAuthoredFlow } from '../authored-root.js';
import { AuthoredHumanParked } from '../authored-flow-error.js';
import { AuthoredFlowLoadError } from '../authored-flow-loader.js';
import { DirectInputError, parseDirectInput } from '../direct-input.js';
import { JournalClient } from '../journal-client.js';
import { inputFailureReport } from './check.js';
import { checkAuthoredTriggers } from './check-triggers.js';
import { authoredWorkerRemedy, localAgentRemedy } from './local-agent-remedy.js';
import {
  authoredCompletion,
  authoredHumanParked,
  authoredStepFailure,
  connect,
  emptyReport,
  fromCheckReport,
  protocolFailure,
  socketFor,
  type RunExecution,
  type RunLifecycleOptions,
  type RunReport,
} from './run.js';

export async function runDirectFlow(
  path: string,
  inputArgument: string | undefined,
  dataDir: string,
  options: RunLifecycleOptions = {},
): Promise<RunExecution> {
  let input: unknown;
  try {
    input = parseDirectInput(inputArgument);
  } catch (error) {
    const failure = error instanceof DirectInputError ? error : {
      kind: 'input_invalid' as const,
      message: 'Direct input could not be parsed.',
    };
    return {
      exitCode: 2,
      report: fromCheckReport('run', inputFailureReport(failure, path)),
    };
  }

  // Declared triggers are knowable before any daemon or step is started.
  // Importing the authored module is unavoidable here — trigger sources
  // are only observable after `flow(...).on(webhook(...))` has run — but
  // the authored body is not called, so a side-effect-in-body flow still
  // has its body deferred until after daemon-attach below.
  const checked = await checkAuthoredTriggers(path);
  if (!checked.report.ok || checked.loaded === undefined) {
    return { exitCode: 2, report: fromCheckReport('run', checked.report) };
  }
  const socketPath = socketFor(dataDir);
  const base: RunReport = { ...emptyReport('run'), path };
  const client = new JournalClient(socketPath);
  const connected = await connect(client, 'run', dataDir, base, options);
  if (connected !== undefined) return connected;

  let localAgent: Awaited<ReturnType<typeof attachLocalAgent>> | undefined;
  let localLlm: LlmWorker | undefined;
  let llmClient: JournalClient | undefined;
  let llmFailure: unknown;
  const admissionIdentity = options.authoredAdmissionKey
    ?? process.env['RELAYFLOW_AUTHORED_ADMISSION_KEY'] ?? randomUUID();
  try {
    if (options.localAgent) {
      localAgent = await attachLocalAgent(
        client, dataDir, options.onPtyReady, authoredLocalAgentStream(admissionIdentity),
      );
      // A session owns one worker registration. Keep the workspace-free LLM
      // worker on its own connection so it cannot replace the agent worker.
      llmClient = new JournalClient(socketPath);
      await llmClient.connect();
      await llmClient.hello('flows-local-llm');
      localLlm = new LlmWorker(llmClient, `${localAgent.stream}-llm`);
      localLlm.on('error', error => { llmFailure = error; client.close(); });
      await localLlm.attach();
    }
    const result = await executeDurableAuthoredFlow(
      checked.loaded, client, input,
      {
        dataDir,
        admissionKey: admissionIdentity,
        localAgentStream: localAgent?.stream,
        lifecycle: {
          onProgress: options.onProgress,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          ...(options.onWait !== undefined ? { onWait: options.onWait } : {}),
        },
      },
    );
    const terminal = result.journalSteps.at(-1);
    if (terminal === undefined) {
      return protocolFailure('run', base, socketPath, new Error(
        `authored flow "${result.name}" completed without a journal step`,
      ));
    }
    return authoredCompletion('run', base, socketPath, result, result.rootRunId);
  } catch (caught) {
    if (caught instanceof McpPreflightError) return {
      exitCode: 2, report: fromCheckReport('run', caught.report),
    };
    if (caught instanceof McpStepError) return {
      exitCode: 1,
      report: { ...base, ok: false, runId: caught.runId, socketPath,
        status: 'failed', completionReason: 'step_failed',
        diagnostics: [...base.diagnostics, { severity: 'failure', kind: 'step_failed', message: caught.message }],
      },
    };
    // Preserve authored classifications/run IDs; use the worker's cause only
    // when its connection teardown left a generic transport error.
    const error = caught instanceof AuthoredFlowExecutionError || caught instanceof AuthoredFlowLoadError
      ? caught : llmFailure ?? localAgent?.failure ?? caught;
    // `agent_cli_unresolved` and `unsupported_workspace_permission` are
    // preflight-shaped refusals, not protocol failures — `flows check`
    // returns exit 2 for the equivalent declarative-spec failures, and this
    // path should match it. Known gap, not solved here: if a `f.run` before
    // the failing `f.agent` already journaled real work, this still reports
    // as a clean refusal — true upfront preflight would need to know every
    // `f.agent` call an imperative TS body will make before running any of
    // it, which isn't knowable without running the body (see the comment on
    // ExecuteAuthoredFlowOptions and this project's own examples/README for
    // the same limitation already documented elsewhere).
    if (error instanceof AuthoredFlowLoadError
      || (error instanceof AuthoredFlowExecutionError
        && (error.code === 'helper_slack.credential_missing'
          || error.code === 'helper_slack.mount_required'
          || error.code === 'budget_syntax_invalid'
          || error.code === 'unsupported_promise_lifecycle'
          || error.code === 'unsupported_header'
          || error.code === 'agent_cli_unresolved'
          || error.code === 'llm_cli_unresolved'
          || error.code === 'unsupported_workspace_permission'))) {
      return {
        exitCode: 2,
        report: {
          ...fromCheckReport('run', inputFailureReport({
            kind: error instanceof AuthoredFlowExecutionError && (
              error.code === 'helper_slack.credential_missing'
              || error.code === 'helper_slack.mount_required'
              || error.code === 'budget_syntax_invalid'
            ) ? error.code : 'invalid_spec',
            message: error.message,
          }, path)),
          socketPath,
        },
      };
    }
    if (error instanceof AuthoredFlowExecutionError && (error.code === 'agent_parked' || error.code === 'llm_parked')) {
      return {
        exitCode: 3,
        report: {
          ...base,
          ok: false,
          runId: error.runId,
          rootRunId: error.rootRunId,
          socketPath,
          status: 'parked',
          parkCause: error.parkCause,
          diagnostics: [...base.diagnostics, {
            severity: 'parked',
            kind: 'run_parked',
            // The remedy is rendered here rather than by the child's own
            // `classifyOutcome`, which is deliberately silent for authored
            // paths: this is the only frame that knows both the flow path and
            // the `--input` argument a new run has to repeat, and it knows
            // whether a worker was already attached.
            message: error.message + localAgentRemedy(authoredWorkerRemedy(
              error.parkCause, options.localAgent === true,
              { path, input: inputArgument, dataDir },
            )),
          }],
        },
      };
    }
    // A step that ran and failed is a run failure, not a protocol failure. The
    // diagnostic carried up from `classifyOutcome` already names the step, its
    // exit code and its output tail; this branch is what lets it reach the
    // terminal. `resumeFlow` takes the same branch, through the same helper.
    if (error instanceof AuthoredFlowExecutionError && (error.code === 'step_failed' || error.code === 'gate_failed')) {
      return authoredStepFailure('run', base, socketPath, error);
    }
    if (error instanceof AuthoredHumanParked) {
      return authoredHumanParked('run', base, socketPath, error, { dataDir, localAgent: options.localAgent === true });
    }
    const runId = error instanceof AuthoredFlowExecutionError ? error.runId : undefined;
    return protocolFailure('run', base, socketPath, error, runId);
  } finally {
    try {
      await localLlm?.close();
      await localAgent?.close();
    } finally { llmClient?.close(); client.close(); }
  }
}
