// The Cloud executor for `evaluateFlow`: one fresh hosted run per case,
// waited on, with its verdict read from the hosted run report and its spend
// from the run's steps.

import { getCloudRunSteps, type CloudStep } from './cloud-read.js';
import { runInCloud, waitForCloudFlowRun, type RunInCloudOptions } from './cloud-run.js';
import { cloudRunState } from './cloud-run-record.js';
import { cloudRequest, isCloudRecord, type CloudConnectionOptions } from './cloud-http.js';
import { isAuthoredFlowPath } from './direct-input.js';
import type { FlowEvalExecutor, FlowEvalRun } from './flow-eval-report.js';
import { runReportOutcome } from './flow-eval-outcome.js';
import { flowEvalSources, isPathTarget, type FlowEvalTarget } from './flow-eval-version.js';

const MODULE = /\.(?:[mc]?[jt]s)$/u;

/**
 * Cloud receives the entry file's source alone (cloud-run.ts): a relative
 * import is not resolved by the hosted runner, even with `syncCode`. A flow
 * whose version spans local modules would therefore fail only on Cloud, or run
 * something other than what was judged. Refuse it before submitting anything.
 */
async function refuseLocalImports(flow: FlowEvalTarget): Promise<void> {
  if (!isPathTarget(flow) || !MODULE.test(flow.path)) return;
  const { files } = await flowEvalSources(flow);
  const entry = files.find(file => !file.includes('/') && flow.path.endsWith(file));
  const modules = files.filter(file => MODULE.test(file) && file !== entry);
  if (modules.length > 0) {
    throw new Error(`Cloud evaluation runs the entry file alone, and this flow imports local modules (${modules.join(', ')}). `
      + 'Evaluate it locally, or inline those modules.');
  }
}

export interface CloudFlowEvalExecutorOptions extends CloudConnectionOptions {
  workspaceId?: string;
  syncCode?: RunInCloudOptions['syncCode'];
  pollIntervalMs?: number;
}

/**
 * Execute each case as a fresh hosted run and wait for it. Needs a token with
 * `workflow:invoke:write` and `runs:read`; inside a Cloud step that means an
 * injected workspace token, since a run-scoped sandbox token reads only its own run.
 */
export function cloudFlowEvalExecutor(options: CloudFlowEvalExecutorOptions = {}): FlowEvalExecutor {
  return async ({ flow, input, signal }) => {
    await refuseLocalImports(flow);
    const connection: CloudConnectionOptions = {
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      ...(options.token === undefined ? {} : { token: options.token }),
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(signal === undefined ? {} : { signal }),
    };
    const receipt = await runInCloud(flow, {
      ...connection,
      ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
      ...(options.syncCode === undefined ? {} : { syncCode: options.syncCode }),
      // Cloud requires an explicit input for authored source; `{}` is the
      // documented "no fields", matching the local executor's default.
      ...(input !== undefined ? { input } : 'path' in flow && isAuthoredFlowPath(flow.path) ? { input: {} } : {}),
    });
    await waitForCloudFlowRun(receipt.runId, {
      ...connection, ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    });
    // Re-read the terminal record for its stored report: the run state alone
    // carries the kernel's reason, which says `success` for a declined body
    // and has no completion detail.
    const record = await cloudRequest(`/api/v1/workflows/runs/${receipt.runId}`, connection);
    let steps: CloudStep[] | undefined;
    try {
      steps = await getCloudRunSteps(receipt.runId, connection);
    } catch {
      // As locally: spend is evidence, not the verdict.
    }
    return { runId: receipt.runId, ...cloudRunOutcome(record, receipt.runId), ...cloudSpend(steps) };
  };
}

/**
 * Map a terminal hosted run record onto the eval vocabulary: the validated run
 * state decides parked/failed/canceled, and the stored report (the same
 * RunReport a local run prints) supplies `declined` and the completion detail.
 * Exported for tests.
 */
export function cloudRunOutcome(record: unknown, runId: string): Pick<FlowEvalRun, 'completionReason' | 'completionDetail'> {
  const state = cloudRunState(record, runId);
  const report = isCloudRecord(record) && isCloudRecord(record.result) ? record.result : {};
  const mapped = runReportOutcome(report);
  // A park with nothing attached to run it is the same fact on both sides.
  if (mapped.completionReason === 'worker_unavailable') return mapped;
  if (state.status === 'needs_human') return { ...mapped, completionReason: 'needs_human' };
  if (!('completionReason' in state)) return { ...mapped, completionReason: state.status };
  if (state.completionReason === 'success') return mapped.completionReason === 'declined' ? mapped : { ...mapped, completionReason: 'success' };
  return { ...mapped, completionReason: state.completionReason };
}

/** Sum hosted step spend; any step with unknown cost makes the total unknown. Exported for tests. */
export function cloudSpend(steps: readonly CloudStep[] | undefined): Pick<FlowEvalRun, 'costUsd' | 'tokensIn' | 'tokensOut' | 'steps'> {
  if (steps === undefined) return { costUsd: null, tokensIn: null, tokensOut: null };
  const known = (values: Array<number | null>): number | null =>
    values.some(v => v === null || !Number.isFinite(v) || v < 0) ? null : values.reduce<number>((sum, v) => sum + v!, 0);
  const costed = steps.filter(step => step.step_type === 'agent' || step.step_type === 'llm' || step.cost_usd !== null);
  return {
    costUsd: known(costed.map(step => step.cost_usd)),
    tokensIn: known(costed.map(step => step.tokens_in)),
    tokensOut: known(costed.map(step => step.tokens_out)),
    steps: steps.map(step => ({ id: step.step_name, status: step.status, durationMs: step.duration_ms, costUsd: step.cost_usd })),
  };
}
