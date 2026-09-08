import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { canonicalize, specHash } from './canonical.js';
import { compileSpec, compileYaml, toKernelSpec } from './compile.js';
import type { FlowSpec } from './spec.js';
import {
  CloudFlowError, cloudConnection, cloudRequest, cloudRunId, isCloudRecord,
  type CloudConnectionOptions,
} from './cloud-http.js';

export type CloudFlowSource = FlowSpec | { path: string };
export interface RunInCloudOptions extends CloudConnectionOptions {
  workspaceId?: string;
}
export interface CloudRunReceipt {
  runId: string;
  status: 'pending' | 'running';
  /** Identity of the submitted spec, computed using the existing kernel dialect. */
  specHash: string;
  /** Authenticated run API resource; this is not a public sharing URL. */
  apiUrl: string;
}
export interface CloudRunState {
  runId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: unknown;
}

/**
 * Submit a declarative flow to Cloud's pinned v2 runtime. Compilation only
 * happens here; Cloud owns provisioning and the Rust engine owns execution.
 * Returns acceptance, not completion. No local daemon, CLI probe, or node up.
 */
export async function runInCloud(
  flow: CloudFlowSource,
  options: RunInCloudOptions = {},
): Promise<CloudRunReceipt> {
  const { origin } = cloudConnection(options);
  let spec: FlowSpec;
  if ('path' in flow) {
    if (!/\.(?:ya?ml|json)$/iu.test(flow.path)) {
      throw new CloudFlowError('unsupported_source',
        'Cloud v2 currently accepts declarative YAML or JSON specs; authored TypeScript flows are not supported by the hosted runtime.');
    }
    spec = compileYaml(await readFile(flow.path, 'utf8'));
  } else {
    spec = compileSpec(flow);
  }
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
  return { runId, status: result.status, specHash: hash, apiUrl: `${origin}/api/v1/workflows/runs/${runId}` };
}

export async function getCloudFlowRun(
  runId: string,
  options: CloudConnectionOptions = {},
): Promise<CloudRunState> {
  cloudRunId(runId);
  const result = await cloudRequest(`/api/v1/workflows/runs/${runId}`, options);
  if (!isCloudRecord(result) || result.runId !== runId || result.relayflowVersion !== 'v2'
    || !['pending', 'running', 'completed', 'failed', 'cancelled'].includes(String(result.status))) {
    throw new CloudFlowError('invalid_response', 'Cloud returned an invalid v2 run record.');
  }
  return {
    runId,
    status: result.status as CloudRunState['status'],
    ...(result.result === undefined ? {} : { result: result.result }),
  };
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
  for (;;) {
    options.signal?.throwIfAborted();
    const run = await getCloudFlowRun(runId, options);
    if (run.status !== 'pending' && run.status !== 'running') return run;
    await setTimeout(interval, undefined, { signal: options.signal });
  }
}
