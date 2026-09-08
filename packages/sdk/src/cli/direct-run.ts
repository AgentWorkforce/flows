import { attachLocalAgent } from '../local-agent.js';
import {
  AuthoredFlowExecutionError,
  executeAuthoredFlow,
} from '../authored-flow-executor.js';
import { AuthoredFlowLoadError, loadAuthoredFlow } from '../authored-flow-loader.js';
import { DirectInputError, parseDirectInput } from '../direct-input.js';
import { JournalClient } from '../journal-client.js';
import { inputFailureReport } from './check.js';
import {
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

  const socketPath = socketFor(dataDir);
  const base: RunReport = { ...emptyReport('run'), path };
  const client = new JournalClient(socketPath);
  const connected = await connect(client, 'run', dataDir, base, options);
  if (connected !== undefined) return connected;

  let localAgent: Awaited<ReturnType<typeof attachLocalAgent>> | undefined;
  try {
    const { handle, getDefinition } = await loadAuthoredFlow(path);
    if (options.localAgent) localAgent = await attachLocalAgent(client);
    const result = await executeAuthoredFlow(handle, client, input, {
      getDefinition,
      flowPath: path,
      onProgress: options.onProgress,
      localAgentStream: localAgent?.stream,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.onWait !== undefined ? { onWait: options.onWait } : {}),
    });
    const terminal = result.journalSteps.at(-1);
    if (terminal === undefined) {
      return protocolFailure('run', base, socketPath, new Error(
        `authored flow "${result.name}" completed without a journal step`,
      ));
    }
    return {
      exitCode: 0,
      report: {
        ...base,
        ok: true,
        runId: terminal.runId,
        socketPath,
        status: 'completed',
        completionReason: result.completionReason,
        completedSteps: result.journalSteps.length,
      },
    };
  } catch (caught) {
    // Preserve authored classifications/run IDs; use the worker's cause only
    // when its connection teardown left a generic transport error.
    const error = caught instanceof AuthoredFlowExecutionError || caught instanceof AuthoredFlowLoadError
      ? caught : localAgent?.failure ?? caught;
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
        && (error.code === 'unsupported_header'
          || error.code === 'agent_cli_unresolved'
          || error.code === 'unsupported_workspace_permission'))) {
      return {
        exitCode: 2,
        report: {
          ...fromCheckReport('run', inputFailureReport({
            kind: 'invalid_spec',
            message: error.message,
          }, path)),
          socketPath,
        },
      };
    }
    if (error instanceof AuthoredFlowExecutionError && error.code === 'agent_parked') {
      return {
        exitCode: 3,
        report: {
          ...base,
          ok: false,
          runId: error.runId,
          socketPath,
          status: 'parked',
          diagnostics: [...base.diagnostics, {
            severity: 'parked',
            kind: 'run_parked',
            message: error.message,
          }],
        },
      };
    }
    const runId = error instanceof AuthoredFlowExecutionError ? error.runId : undefined;
    return protocolFailure('run', base, socketPath, error, runId);
  } finally {
    try { await localAgent?.close(); } finally { client.close(); }
  }
}
