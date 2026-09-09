import { RUN_COMPLETION_REASONS } from '@relayflows/surface';
import type { RunCompletionReason } from './protocol.js';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { parse as parseYaml } from 'yaml';
import { canonicalize, specHash } from './canonical.js';
import { CompileError, compileSpec, kernelToAuthoring, toKernelSpec } from './compile.js';
import type { FlowSpec } from './spec.js';
import {
  CloudFlowError, cloudConnection, cloudRequest, cloudRunId, isCloudRecord,
  type CloudConnectionOptions,
} from './cloud-http.js';

export type CloudFlowSource = FlowSpec | { path: string };
export interface RunInCloudOptions extends CloudConnectionOptions {
  /** Existing Cloud workspace to run in; provisioning/authorization remains server-side. */
  workspaceId?: string;
}
export interface CloudRunReceipt {
  runId: string;
  status: 'pending' | 'running';
  /** Local correlation hash of the compiled spec; NOT server attestation or a sealed bundle digest. */
  specHash: string;
  /** Authenticated run API resource; this is not a public sharing URL. */
  apiUrl: string;
}
export type CloudRunState =
  | { runId: string; status: 'pending' | 'running' }
  | { runId: string; status: 'completed' | 'failed' | 'cancelled'; completionReason: RunCompletionReason };

/**
 * Submit a declarative flow to Cloud's pinned v2 runtime. Compilation only
 * happens here; Cloud owns provisioning and the Rust engine owns execution.
 * Returns acceptance, not completion. No local daemon, CLI probe, or node up.
 */
export async function runInCloud(
  flow: CloudFlowSource,
  options: RunInCloudOptions = {},
): Promise<CloudRunReceipt> {
  const { baseUrl } = cloudConnection(options);
  let spec: FlowSpec;
  try {
    options.signal?.throwIfAborted();
    if ('path' in flow) {
      if (!/\.(?:ya?ml|json)$/iu.test(flow.path)) {
        throw new CloudFlowError('unsupported_source',
          'Cloud v2 currently accepts declarative YAML or JSON specs; authored TypeScript flows are not supported by the hosted runtime.');
      }
      const parsed: unknown = parseYaml(await readFile(flow.path, 'utf8'));
      try {
        spec = compileSpec(parsed);
      } catch (error) {
        if (!(error instanceof CompileError)) throw error;
        // Prefer the authoring dialect; accept compiled kernel JSON for local-CLI
        // compatibility. If both fail, retain the original authoring diagnostic.
        try {
          spec = compileSpec(kernelToAuthoring(parsed));
        } catch {
          throw error;
        }
      }
    } else {
      spec = compileSpec(flow);
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof CloudFlowError) throw error;
    throw new CloudFlowError('invalid_input', 'Cannot read or compile the declarative flow. Check the file path and YAML/JSON spec.');
  }
  options.signal?.throwIfAborted();
  const hash = specHash(toKernelSpec(spec));
  const result = await cloudRequest('/api/v1/workflows/run', options, {
    // JSON is a YAML subset. Sending canonical data preserves the exact spec
    // while using the server's existing YAML-to-config admission path.
    workflow: canonicalize(spec),
    fileType: 'yaml',
    relayflowVersion: 'v2',
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
  });
  if (!isCloudRecord(result) || (result.status !== 'pending' && result.status !== 'running')) {
    throw new CloudFlowError('invalid_response', 'Cloud did not return an accepted run.');
  }
  const runId = cloudRunId(result.runId);
  return { runId, status: result.status, specHash: hash, apiUrl: `${baseUrl}/api/v1/workflows/runs/${runId}` };
}

export async function getCloudFlowRun(
  runId: string,
  options: CloudConnectionOptions = {},
): Promise<CloudRunState> {
  cloudRunId(runId);
  const result = await cloudRequest(`/api/v1/workflows/runs/${runId}`, options);
  if (!isCloudRecord(result) || result.runId !== runId || result.relayflowVersion !== 'v2'
    || typeof result.status !== 'string'
    || !['pending', 'running', 'completed', 'failed', 'cancelled'].includes(result.status)) {
    throw new CloudFlowError('invalid_response', 'Cloud returned an invalid v2 run record.');
  }
  if (result.status === 'pending' || result.status === 'running') return { runId, status: result.status };
  const report = result.result;
  const reason = isCloudRecord(report) ? report.completionReason : undefined;
  if (typeof reason !== 'string' || !(RUN_COMPLETION_REASONS as readonly string[]).includes(reason)
    || (result.status === 'completed' && (reason !== 'success' || !isCloudRecord(report) || report.ok !== true || report.status !== 'completed'))
    || (result.status === 'failed' && !['step_failed', 'budget_exceeded'].includes(reason))
    || (result.status === 'cancelled' && reason !== 'canceled')) {
    throw new CloudFlowError('invalid_response', 'Cloud terminal record lacks a valid, consistent run completionReason; no execution outcome is attested.');
  }
  return { runId, status: result.status as 'completed' | 'failed' | 'cancelled', completionReason: reason as RunCompletionReason };
}

/** Wait without a fixed execution deadline. Abort stops observation, not the hosted run. */
export async function waitForCloudFlowRun(
  runId: string,
  options: CloudConnectionOptions & { pollIntervalMs?: number } = {},
): Promise<CloudRunState> {
  const interval = options.pollIntervalMs ?? 2_000;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 60_000) {
    throw new CloudFlowError('configuration', 'pollIntervalMs must be an integer from 1 to 60000.');
  }
  let failures = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      const run = await getCloudFlowRun(runId, options);
      failures = 0;
      if (run.status !== 'pending' && run.status !== 'running') return run;
    } catch (error) {
      options.signal?.throwIfAborted();
      const transient = error instanceof CloudFlowError && (error.code === 'transient_error'
        || (error.code === 'http_error' && [408, 429, 500, 502, 503, 504].includes(error.status ?? 0)));
      if (!transient) throw error;
      // Only safe GET observation retries. Delay caps at 30s; no overall run deadline.
      failures = Math.min(failures + 1, 16);
    }
    await setTimeout(failures ? Math.min(interval * 2 ** (failures - 1), 30_000) : interval,
      undefined, { signal: options.signal });
  }
}
