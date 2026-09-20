import { RUN_COMPLETION_REASONS, type ScheduleTriggerSource } from '@relayflows/surface';
import type { RunCompletionReason } from './protocol.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { parse as parseYaml } from 'yaml';
import { canonicalize, specHash } from './canonical.js';
import { CompileError, compileSpec, kernelToAuthoring, toKernelSpec } from './compile.js';
import type { FlowSpec } from './spec.js';
import { snapshotJsonValue, type JsonValue } from './json-value.js';
import { loadAuthoredFlow, type SurfaceModuleAuthority } from './authored-flow-loader.js';
import {
  CloudFlowError, cloudConnection, cloudFetch, cloudRequest, cloudRunId, isCloudRecord,
  type CloudConnectionOptions,
} from './cloud-http.js';
import { packWorkingTree, prepareCloudSync, uploadCloudCode } from './cloud-sync.js';

export type CloudFlowSource = FlowSpec | { path: string };
export interface RunInCloudOptions extends CloudConnectionOptions {
  /** Existing Cloud workspace to run in; provisioning/authorization remains server-side. */
  workspaceId?: string;
  /** Exact JSON input. Required at runtime for authored .flow.ts; refused for declarative source. */
  input?: JsonValue;
  /**
   * Upload this working tree before submission so the hosted run executes
   * inside it (v1's `--sync-code`). Cloud-API storage only; see cloud-sync.ts.
   * The submitted flow still travels as source in the request body, so it
   * must remain self-contained: sibling imports inside the tree are not
   * resolved by the hosted runner.
   */
  syncCode?: { root: string };
  /**
   * Called immediately before the one non-idempotent request, the run
   * submission. Everything before it (prepare, pack, upload) is safe to
   * retry, so a caller classifying an interruption can tell "nothing was
   * admitted" from "admission unknown".
   */
  onSubmit?: () => void;
}
export interface CloudRunReceipt {
  runId: string;
  status: 'pending' | 'running';
  /** Local correlation hash of the compiled spec; NOT server attestation or a sealed bundle digest. */
  specHash: string;
  /** Authenticated run API resource; this is not a public sharing URL. */
  apiUrl: string;
  /** Present when a working tree was synced: what was uploaded, by count and size. */
  synced?: { files: number; bytes: number; skippedLinks: string[] };
}
export interface CloudAuthoredAuthority {
  readonly schemaVersion: 1;
  readonly sourceSha256: string;
  readonly byteLength: number;
  readonly surface: SurfaceModuleAuthority;
}
/** The request-body fields a submission contributes; identical for a run and a schedule. */
export function cloudSubmissionBody(submission: CloudSubmission): Record<string, unknown> {
  return {
    workflow: submission.workflow,
    fileType: submission.fileType,
    relayflowVersion: 'v2',
    ...(submission.authoredAuthority === undefined ? {} : { authoredAuthority: submission.authoredAuthority }),
    ...(submission.inputPresent ? { inputs: submission.inputs } : {}),
  };
}

export type CloudRunState =
  | { runId: string; status: 'pending' | 'launching' | 'running' }
  | { runId: string; status: 'completed' | 'failed' | 'cancelled'; completionReason: RunCompletionReason };

/**
 * Submit a declarative flow to Cloud's pinned v2 runtime. Compilation only
 * happens here; Cloud owns provisioning and the Rust engine owns execution.
 * Returns acceptance, not completion. No local daemon, CLI probe, or node up.
 */
/**
 * What a Cloud submission carries, before any request: the exact source or
 * canonical spec, the pinned authority for authored source, the input, and a
 * local correlation hash. Shared by `runInCloud` and `scheduleInCloud`, so a
 * schedule stores exactly what a run would send.
 */
export interface CloudSubmission {
  readonly workflow: string;
  readonly fileType: 'yaml' | 'ts';
  readonly authoredAuthority?: CloudAuthoredAuthority;
  readonly inputs?: JsonValue;
  readonly inputPresent: boolean;
  readonly specHash: string;
  /** The authored flow's declared name, or the spec name. */
  readonly name: string;
  /** Authored `schedule.*` handlers, for `flows schedule` to pick up. */
  readonly schedules: readonly ScheduleTriggerSource[];
}

export async function prepareCloudSubmission(
  flow: CloudFlowSource,
  options: { input?: JsonValue; signal?: AbortSignal } = {},
): Promise<CloudSubmission> {
  let spec: FlowSpec | undefined;
  let authored: { source: string; authority: CloudAuthoredAuthority; name: string; schedules: ScheduleTriggerSource[] } | undefined;
  const inputPresent = Object.prototype.hasOwnProperty.call(options, 'input');
  let authoredInput: JsonValue | undefined;
  try {
    options.signal?.throwIfAborted();
    if ('path' in flow) {
      if (/\.flow\.ts$/iu.test(flow.path)) {
        const bytes = await readFile(flow.path);
        const source = bytes.toString('utf8');
        if (!bytes.length || Buffer.from(source, 'utf8').compare(bytes) !== 0) {
          throw new CloudFlowError('invalid_input', 'Authored source must be nonempty, lossless UTF-8.');
        }
        let loaded: Awaited<ReturnType<typeof loadAuthoredFlow>>;
        let definition: ReturnType<typeof loaded.getDefinition>;
        try {
          loaded = await loadAuthoredFlow(flow.path);
          definition = loaded.getDefinition(loaded.handle);
        } catch (error) {
          // An authored source that does not load is an authoring problem, and
          // the most common one is `@relayflows/surface` not being resolvable
          // from the flow's directory. Name it; do not call it a spec problem.
          throw new CloudFlowError('unsupported_source',
            `${flow.path} is not a loadable authored flow: ${error instanceof Error ? error.message : String(error)}. `
            + 'Run `flows check` on it from the same directory.');
        }
        if (loaded.extensions.length > 0) {
          throw new CloudFlowError('unsupported_source',
            `Cloud authored submission does not yet accept flow extensions (${loaded.extensions.map(e => e.name).join(', ')} composed by flows.json).`);
        }
        if (loaded.graph.length !== 1) {
          throw new CloudFlowError('unsupported_source',
            'Cloud authored submission currently accepts one self-contained .flow.ts source without use dependencies.');
        }
        authored = {
          source,
          name: definition.name,
          schedules: definition.handlers.flatMap(h => h.trigger.kind === 'schedule' ? [h.trigger] : []),
          authority: Object.freeze({
            schemaVersion: 1,
            sourceSha256: createHash('sha256').update(bytes).digest('hex'),
            byteLength: bytes.length,
            surface: loaded.surfaceAuthority,
          }),
        };
      } else if (!/\.(?:ya?ml|json)$/iu.test(flow.path)) {
        throw new CloudFlowError('unsupported_source',
          'Cloud v2 accepts declarative YAML/JSON specs or authored .flow.ts source.');
      } else {
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
      }
    } else {
      spec = compileSpec(flow);
    }
    if (authored !== undefined) {
      if (!inputPresent) {
        throw new CloudFlowError('invalid_input', 'Cloud authored .flow.ts requires an explicit JSON input. Pass {} when the flow needs no fields.');
      }
      authoredInput = snapshotJsonValue(options.input, 'Cloud authored input');
    } else if (inputPresent) {
      throw new CloudFlowError('invalid_input', 'Cloud input is supported only for authored .flow.ts source.');
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof CloudFlowError) throw error;
    throw new CloudFlowError('invalid_input', 'Cannot read or compile the declarative flow. Check the file path and YAML/JSON spec.');
  }
  options.signal?.throwIfAborted();
  if (authored === undefined) {
    const kernel = toKernelSpec(spec!);
    // JSON is a YAML subset. Sending canonical data preserves the exact spec
    // while using the server's existing YAML-to-config admission path.
    return { workflow: canonicalize(spec), fileType: 'yaml', inputPresent: false, specHash: specHash(kernel),
      name: spec!.name ?? "flow", schedules: [] };
  }
  return {
    workflow: authored.source, fileType: 'ts', authoredAuthority: authored.authority,
    inputs: authoredInput, inputPresent: true, name: authored.name, schedules: authored.schedules,
    specHash: createHash('sha256').update(canonicalize({ authority: authored.authority, input: authoredInput })).digest('hex'),
  };
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
  const { baseUrl } = cloudConnection(options);
  const submission = await prepareCloudSubmission(flow, options);
  const hash = submission.specHash;
  // Sync before submission: `prepare` reserves the run ID and the upload lands
  // under it, so the run request below names code Cloud already holds. A
  // refused backend or failed upload therefore never leaves a launched run
  // pointing at a tree that is not there.
  let synced: { runId: string; codeKey: string; files: number; bytes: number; skippedLinks: string[] } | undefined;
  if (options.syncCode !== undefined) {
    const prepared = await prepareCloudSync(options);
    options.signal?.throwIfAborted();
    const packed = await packWorkingTree(options.syncCode.root);
    try {
      options.signal?.throwIfAborted();
      await uploadCloudCode(prepared, packed, options);
    } finally {
      packed.dispose();
    }
    synced = { runId: prepared.runId, codeKey: prepared.codeKey, files: packed.files.length, bytes: packed.bytes,
      skippedLinks: packed.skippedLinks };
  }
  options.signal?.throwIfAborted();
  options.onSubmit?.();
  let result: unknown;
  try {
    result = await cloudFetch('/api/v1/workflows/run', options, { method: 'POST', detail: true, body: JSON.stringify({
      ...cloudSubmissionBody(submission),
      ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
      ...(synced === undefined ? {} : { runId: synced.runId, s3CodeKey: synced.codeKey }),
    }) });
  } catch (error) {
    // Cloud accepts exactly one authored Surface (the one its sandbox runs).
    // A CLI on another release is refused with this code; say which side is
    // which instead of leaving the user with a bare 400 (flows#461).
    if (error instanceof CloudFlowError && submission.authoredAuthority !== undefined
      && error.refusal?.code === 'relayflow_v2_authored_authority_invalid') {
      const expected = error.refusal.expected?.version;
      throw new CloudFlowError('unsupported_source',
        `Cloud refused this authored flow's Surface: it runs @relayflows/surface ${expected ?? '(version not reported)'} `
        + `and this CLI authored against ${submission.authoredAuthority.surface.version}. `
        + 'Install the matching relayflows release, or deploy the flow with `flows deploy`, which uses Cloud\'s own Surface.',
        error.status, error.refusal);
    }
    throw error;
  }
  if (!isCloudRecord(result) || (result.status !== 'pending' && result.status !== 'running')) {
    throw new CloudFlowError('invalid_response', 'Cloud did not return an accepted run.');
  }
  const runId = cloudRunId(result.runId);
  if (synced !== undefined && runId !== synced.runId) {
    throw new CloudFlowError('invalid_response',
      `Cloud accepted run ${runId} but the synced code was uploaded for ${synced.runId}.`);
  }
  return {
    runId, status: result.status, specHash: hash, apiUrl: `${baseUrl}/api/v1/workflows/runs/${runId}`,
    ...(synced === undefined ? {} : { synced: { files: synced.files, bytes: synced.bytes, skippedLinks: synced.skippedLinks } }),
  };
}

export async function getCloudFlowRun(
  runId: string,
  options: CloudConnectionOptions = {},
): Promise<CloudRunState> {
  cloudRunId(runId);
  const result = await cloudRequest(`/api/v1/workflows/runs/${runId}`, options);
  if (!isCloudRecord(result) || result.runId !== runId || result.relayflowVersion !== 'v2'
    || typeof result.status !== 'string'
    || !['pending', 'launching', 'running', 'completed', 'failed', 'cancelled'].includes(result.status)) {
    throw new CloudFlowError('invalid_response', 'Cloud returned an invalid v2 run record.');
  }
  if (result.status === 'pending' || result.status === 'launching' || result.status === 'running') {
    return { runId, status: result.status };
  }
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
      if (run.status !== 'pending' && run.status !== 'launching' && run.status !== 'running') return run;
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
