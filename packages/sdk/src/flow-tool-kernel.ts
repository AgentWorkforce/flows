import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalize } from './canonical.js';
import { sha256, verifyBundle } from './bundle.js';
import { FlowToolError, type FlowToolCatalogEntryV1, type FlowToolEventV1,
  type FlowToolRunState, type FlowToolRunV1, type FlowToolTerminalReason } from './flow-tool-contract.js';
import type { FlowToolRequest, FlowToolTransport } from './flow-tool-client.js';
import { flowToolOperationKey } from './flow-tool-client.js';
import { JournalClient, JournalProtocolError } from './journal-client.js';
import { parseFlowToolEntry, parseFlowToolInvocation, flowToolRunLinks, toolId } from './flow-tool-wire.js';
import { validateFlowToolResult } from './flow-tool-manifest.js';
import type { FlowToolJson } from './flow-tool-schema.js';
import type { KernelDeterministicStep, KernelRunSpec } from './spec.js';

/** The only executable accepted by the v1 embedded runtime. It receives JSON as argv data. */
export const FLOW_TOOL_INPUT_PLACEHOLDER = '__RELAYFLOWS_FLOW_TOOL_INPUT_V1__';
const RESULT_STEP = 'flow-tool-result';
const MAX_RESULT_BYTES = 60 * 1024; // below relayflowd's 64 KiB stdout tail

export interface KernelFlowToolDeployment {
  readonly entry: FlowToolCatalogEntryV1;
  /** A bundle whose content digest is entry.manifest.flow.digest. */
  readonly bundlePath: string;
  /** Operator-owned outcome label, never selected by invocation input. */
  readonly businessVerdict: string;
}

export interface KernelFlowToolControlPlaneOptions {
  readonly journal: JournalClient;
  /** Authenticated server-side identity. This value is hashed before journaling. */
  readonly principal: string;
  readonly deployments: readonly KernelFlowToolDeployment[];
  /** Server-side grants for this principal. Omission grants nothing. */
  readonly authorizedDeploymentIds?: readonly string[];
}

interface LoadedDeployment {
  entry: FlowToolCatalogEntryV1;
  template: KernelRunSpec;
  businessVerdict: string;
}

interface RunBinding {
  kind: 'relayflows.flow-tool-run.v1';
  deployment_id: string;
  manifest_digest: string;
  flow_digest: string;
  input_digest: string;
  principal_digest: string;
  catalog_digest: string;
  business_verdict: string;
}

interface JournalEntry {
  seq: number;
  entry_type: string;
  step_id?: string | null;
  payload: Record<string, unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function runtimeFailure(code: 'unsupported' | 'invalid_contract' = 'unsupported'): never {
  throw new FlowToolError(code);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function preflightTemplate(value: unknown, entry: FlowToolCatalogEntryV1): KernelRunSpec {
  if (!record(value) || !exactKeys(value, ['version', 'name', 'description', 'steps'])
    || typeof value['version'] !== 'string' || value['name'] !== entry.manifest.flow.name
    || !Array.isArray(value['steps']) || value['steps'].length !== 1) runtimeFailure();
  const step = value['steps'][0];
  if (!record(step) || !exactKeys(step, [
    'id', 'type', 'command', 'depends_on', 'max_iterations', 'retry', 'verification', 'timeout_ms',
  ]) || step['id'] !== RESULT_STEP || step['type'] !== 'deterministic'
    || !Array.isArray(step['command']) || step['command'].length !== 3
    || !['/usr/bin/printf', '/bin/printf'].includes(step['command'][0] as string)
    || step['command'][1] !== '%s' || step['command'][2] !== FLOW_TOOL_INPUT_PLACEHOLDER
    || !Array.isArray(step['depends_on']) || step['depends_on'].length !== 0
    || step['max_iterations'] !== 1 || !record(step['retry']) || !record(step['verification'])
    || Object.keys(step['verification']).length !== 0
    || !Number.isSafeInteger(step['timeout_ms']) || (step['timeout_ms'] as number) < 1
    || (step['timeout_ms'] as number) > entry.budget.max_wallclock_ms) runtimeFailure();
  const retry = step['retry'];
  if (!exactKeys(retry, ['initial_backoff_ms', 'max_backoff_ms', 'multiplier', 'jitter_percent'])
    || retry['initial_backoff_ms'] !== 0 || retry['max_backoff_ms'] !== 0
    || retry['multiplier'] !== 1 || retry['jitter_percent'] !== 0) runtimeFailure();
  return value as unknown as KernelRunSpec;
}

async function loadDeployment(deployment: KernelFlowToolDeployment): Promise<LoadedDeployment> {
  let entry: FlowToolCatalogEntryV1;
  try { entry = parseFlowToolEntry(deployment.entry); } catch { runtimeFailure('invalid_contract'); }
  if (entry.effects.length !== 0 || entry.requires_human.length !== 0
    || !entry.business_verdicts.includes(deployment.businessVerdict)) runtimeFailure();
  const expected = entry.manifest.flow.digest.slice('sha256:'.length);
  try {
    const before = await readFile(join(deployment.bundlePath, 'spec.canonical.json'));
    const preflightBefore = await readFile(join(deployment.bundlePath, 'preflight.json'));
    await verifyBundle(deployment.bundlePath, expected);
    const after = await readFile(join(deployment.bundlePath, 'spec.canonical.json'));
    const preflightAfter = await readFile(join(deployment.bundlePath, 'preflight.json'));
    if (!before.equals(after) || !preflightBefore.equals(preflightAfter)) runtimeFailure();
    const report: unknown = JSON.parse(preflightAfter.toString('utf8'));
    if (!record(report) || report['ok'] !== true) runtimeFailure();
    return { entry, template: preflightTemplate(JSON.parse(after.toString('utf8')), entry),
      businessVerdict: deployment.businessVerdict };
  } catch (error) {
    if (error instanceof FlowToolError) throw error;
    runtimeFailure();
  }
}

function bindingDescription(binding: RunBinding): string { return canonicalize(binding); }

function parseBinding(entries: readonly JournalEntry[]): RunBinding {
  const spawned = entries.find(entry => entry.entry_type === 'run.spawned');
  const spec = spawned?.payload['spec'];
  const description = record(spec) ? spec['description'] : undefined;
  try {
    const value: unknown = JSON.parse(typeof description === 'string' ? description : 'null');
    if (!record(value) || value['kind'] !== 'relayflows.flow-tool-run.v1'
      || typeof value['deployment_id'] !== 'string' || typeof value['manifest_digest'] !== 'string'
      || typeof value['flow_digest'] !== 'string' || typeof value['input_digest'] !== 'string'
      || typeof value['principal_digest'] !== 'string' || typeof value['catalog_digest'] !== 'string'
      || typeof value['business_verdict'] !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(value['manifest_digest'])
      || !/^sha256:[a-f0-9]{64}$/.test(value['flow_digest'])
      || !/^sha256:[a-f0-9]{64}$/.test(value['input_digest'])
      || !/^[a-f0-9]{64}$/.test(value['principal_digest'])
      || !/^[a-f0-9]{64}$/.test(value['catalog_digest'])) runtimeFailure('invalid_contract');
    return value as unknown as RunBinding;
  } catch (error) {
    if (error instanceof FlowToolError) throw error;
    runtimeFailure('invalid_contract');
  }
}

function journalEntries(value: unknown[]): JournalEntry[] {
  if (!value.every(item => record(item) && Number.isSafeInteger(item['seq'])
    && typeof item['entry_type'] === 'string' && record(item['payload']))) runtimeFailure('invalid_contract');
  return value as unknown as JournalEntry[];
}

function terminalReason(reason: unknown): FlowToolTerminalReason {
  if (reason === 'success') return 'success';
  if (reason === 'canceled') return 'canceled';
  if (reason === 'budget_exceeded') return 'budget_exceeded';
  return 'execution_failed';
}

function runState(status: string, reason: FlowToolTerminalReason | null): FlowToolRunState {
  if (reason === 'success') return 'completed';
  if (reason === 'canceled') return 'cancelled';
  if (reason !== null) return 'failed';
  if (status === 'parked') return 'parked';
  return 'running';
}

function mapProtocolError(error: unknown, admission = false): never {
  if (error instanceof JournalProtocolError) {
    if (error.code === 'run_admission_conflict') throw new FlowToolError('idempotency_conflict');
    if (error.code === 'run_not_found') throw new FlowToolError('not_authorized');
    throw new FlowToolError('unavailable');
  }
  throw new FlowToolError(admission ? 'transport_error' : 'unavailable');
}

/**
 * Build an authenticated embedded control plane over relayflowd's durable journal.
 * This intentionally supports only the effect-free JSON echo/conformance program;
 * arbitrary declarative, authored, LLM, and agent flows remain unsupported.
 */
export async function createKernelFlowToolControlPlane(
  options: KernelFlowToolControlPlaneOptions,
): Promise<FlowToolTransport> {
  if (typeof options.principal !== 'string' || options.principal.length < 1 || options.principal.length > 1024) {
    runtimeFailure('invalid_contract');
  }
  const principalDigest = sha256(options.principal);
  const grants = new Set(options.authorizedDeploymentIds ?? []);
  const deployments = new Map<string, LoadedDeployment>();
  const names = new Map<string, LoadedDeployment>();
  for (const candidate of options.deployments) {
    const loaded = await loadDeployment(candidate);
    if (deployments.has(loaded.entry.deployment_id) || names.has(loaded.entry.manifest.name)) runtimeFailure('invalid_contract');
    deployments.set(loaded.entry.deployment_id, loaded);
    names.set(loaded.entry.manifest.name, loaded);
  }

  const authorized = (deployment: LoadedDeployment): boolean => grants.has(deployment.entry.deployment_id);

  async function readAuthorizedRun(runId: string) {
    toolId(runId);
    let entries: JournalEntry[];
    try { entries = journalEntries((await options.journal.journalRead(runId, 1, 1000)).entries); }
    catch (error) { mapProtocolError(error); }
    const binding = parseBinding(entries!);
    const deployment = deployments.get(binding.deployment_id);
    if (deployment === undefined || !authorized(deployment) || binding.principal_digest !== principalDigest
      || binding.manifest_digest !== deployment.entry.manifest.digest
      || binding.flow_digest !== deployment.entry.manifest.flow.digest
      || binding.catalog_digest !== sha256(canonicalize(deployment.entry))
      || binding.business_verdict !== deployment.businessVerdict) throw new FlowToolError('not_authorized');
    return { deployment, binding, entries: entries! };
  }

  async function projectRun(runId: string): Promise<FlowToolRunV1> {
    const { deployment, binding, entries } = await readAuthorizedRun(runId);
    let snapshot: Awaited<ReturnType<JournalClient['runGet']>>;
    try { snapshot = await options.journal.runGet(runId); } catch (error) { mapProtocolError(error); }
    const completed = entries.find(entry => entry.entry_type === 'step.completed' && entry.step_id === RESULT_STEP);
    const ended = entries.find(entry => entry.entry_type === 'run.completed');
    let reason = ended === undefined ? null : terminalReason(ended.payload['completionReason']);
    if (reason === null && ['failed', 'interrupted'].includes(snapshot!.status)) reason = 'execution_failed';
    let result: Readonly<Record<string, FlowToolJson>> | null = null;
    if (reason === 'success') {
      try {
        const output = completed?.payload['output'];
        if (!record(output) || typeof output['stdout_tail'] !== 'string') throw new Error('missing output');
        result = validateFlowToolResult(deployment.entry.manifest, JSON.parse(output['stdout_tail']));
      } catch { reason = 'execution_failed'; }
    }
    const state = runState(snapshot!.status, reason);
    const sequence = Math.max(0, ...entries.map(entry => entry.seq));
    const evidence = { journal_digest: `sha256:${sha256(canonicalize(entries))}` as const,
      flow_digest: deployment.entry.manifest.flow.digest, artifacts: [], redacted_transcript_refs: [] };
    const terminal = reason === null ? null : {
      terminal_reason: reason,
      business_verdict: reason === 'success' ? deployment.businessVerdict : null,
      result: reason === 'success' ? result : null,
      gates: [], evidence,
      spend: { tokens_in: snapshot!.budget.tokens_in, tokens_out: snapshot!.budget.tokens_out,
        dollars: snapshot!.budget.dollars, dollars_unmetered: snapshot!.budget.dollars_unmetered === true },
    };
    return { api_version: 1, accepted: true, run_id: runId, tool_name: deployment.entry.manifest.name,
      deployment_id: deployment.entry.deployment_id, manifest_digest: deployment.entry.manifest.digest,
      flow_digest: deployment.entry.manifest.flow.digest, input_digest: binding.input_digest as `sha256:${string}`,
      state, sequence, ...flowToolRunLinks(runId), terminal };
  }

  function eventsFor(run: FlowToolRunV1, entries: readonly JournalEntry[], after: number): FlowToolEventV1[] {
    const projected: FlowToolEventV1[] = [];
    for (const entry of entries) {
      if (entry.seq <= after) continue;
      if (entry.entry_type === 'run.spawned') projected.push({ api_version: 1, run_id: run.run_id,
        flow_digest: run.flow_digest, sequence: entry.seq, type: 'run.accepted', state: 'accepted' });
      else if (entry.entry_type === 'step.completed') projected.push({ api_version: 1, run_id: run.run_id,
        flow_digest: run.flow_digest, sequence: entry.seq, type: 'step.completed', state: 'running',
        ...(entry.step_id === null || entry.step_id === undefined ? {} : { step_id: entry.step_id }) });
      else if (entry.entry_type === 'run.completed') projected.push({ api_version: 1, run_id: run.run_id,
        flow_digest: run.flow_digest, sequence: entry.seq, type: 'run.terminal', state: run.state,
        terminal_reason: run.terminal!.terminal_reason });
    }
    return projected;
  }

  return {
    async request(request: FlowToolRequest): Promise<unknown> {
      if (request.method === 'GET' && request.path === '/api/v1/flow-tools') {
        return { api_version: 1, tools: [...deployments.values()].filter(authorized).map(value => value.entry) };
      }
      const invoke = request.path.match(/^\/api\/v1\/flow-tools\/([^/]+)\/invoke$/);
      if (request.method === 'POST' && invoke !== null) {
        const deployment = names.get(invoke[1]!);
        if (deployment === undefined || !authorized(deployment)) throw new FlowToolError('not_authorized');
        flowToolOperationKey(request.idempotencyKey);
        const body = parseFlowToolInvocation(request.body, deployment.entry);
        const encoded = canonicalize(body.input);
        if (Buffer.byteLength(encoded) > MAX_RESULT_BYTES) throw new FlowToolError('unsupported');
        const binding: RunBinding = { kind: 'relayflows.flow-tool-run.v1', deployment_id: deployment.entry.deployment_id,
          manifest_digest: deployment.entry.manifest.digest, flow_digest: deployment.entry.manifest.flow.digest,
          input_digest: body.input_digest, principal_digest: principalDigest,
          catalog_digest: sha256(canonicalize(deployment.entry)), business_verdict: deployment.businessVerdict };
        const step = deployment.template.steps[0]! as KernelDeterministicStep;
        const spec: KernelRunSpec = { ...deployment.template, description: bindingDescription(binding), steps: [{
          ...step, command: [(step.command as string[])[0]!, '%s', encoded],
        }] };
        const admissionKey = `flow-tool:${sha256(canonicalize([principalDigest, deployment.entry.deployment_id,
          deployment.entry.manifest.flow.digest, deployment.entry.manifest.digest, request.idempotencyKey]))}`;
        let started: Awaited<ReturnType<JournalClient['runStart']>>;
        try { started = await options.journal.runStart(spec, undefined, admissionKey); }
        catch (error) { mapProtocolError(error, true); }
        return projectRun(started!.run_id);
      }
      const runPath = request.path.match(/^\/api\/v1\/flow-runs\/([^/]+)(.*)$/);
      if (runPath === null) throw new FlowToolError('not_found');
      const run = await projectRun(runPath[1]!);
      if (request.method === 'GET' && runPath[2] === '') return run;
      if (request.method === 'GET' && runPath[2] === '/evidence') {
        if (run.terminal === null) throw new FlowToolError('unavailable');
        return { api_version: 1, run_id: run.run_id, evidence: run.terminal.evidence };
      }
      // The conformance program cannot park, so commands are deliberately absent.
      throw new FlowToolError('unsupported');
    },
    async *events(path: string, after: number): AsyncIterable<unknown> {
      const match = path.match(/^\/api\/v1\/flow-runs\/([^/]+)\/events$/);
      if (match === null || !Number.isSafeInteger(after) || after < 0) throw new FlowToolError('invalid_contract');
      const { entries } = await readAuthorizedRun(match[1]!);
      const run = await projectRun(match[1]!);
      for (const event of eventsFor(run, entries, after)) yield event;
    },
  };
}
