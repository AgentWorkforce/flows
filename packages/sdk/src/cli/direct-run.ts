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

  try {
    const { handle, getDefinition } = await loadAuthoredFlow(path);
    const result = await executeAuthoredFlow(handle, client, input, { getDefinition, flowPath: path });
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
  } catch (error) {
    if (error instanceof AuthoredFlowLoadError
      || (error instanceof AuthoredFlowExecutionError && error.code === 'unsupported_header')) {
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
    const runId = error instanceof AuthoredFlowExecutionError ? error.runId : undefined;
    return protocolFailure('run', base, socketPath, error, runId);
  } finally {
    client.close();
  }
}
