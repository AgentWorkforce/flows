import { canonicalize } from './canonical.js';
import { snapshotJsonValue } from './json-value.js';
import { FLOW_TOOL_LIMITS } from './flow-tool-schema.js';
import { validateFlowToolInput } from './flow-tool-manifest.js';
import { FlowToolError, type FlowToolCatalogEntryV1, type FlowToolRunV1, type FlowToolEventV1 } from './flow-tool-contract.js';
import { parseFlowToolCatalog, parseFlowToolEntry, parseFlowToolRun, parseFlowToolEvent, parseFlowToolEvidence, flowToolInputDigest, toolId } from './flow-tool-wire.js';

export interface FlowToolRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
}
/**
 * Authenticated control-plane boundary. Implementations must authorize every
 * operation and durably admit/deduplicate runs; the client owns no run ledger.
 * A test transport is not a hosted implementation. No source-submission fallback.
 */
export interface FlowToolTransport {
  request(request: FlowToolRequest): Promise<unknown>;
  events(path: string, after: number): AsyncIterable<unknown>;
}
export interface FlowToolInvocationOptions {
  /** Host-owned operation identity; preserve across reconnect/retry, never generate per retry. */
  readonly idempotencyKey: string;
  readonly mode?: 'async' | 'sync';
  /** Server-side observation bound only, not an execution timeout or cancellation. */
  readonly waitMs?: number;
}
export function flowToolOperationKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new FlowToolError('invalid_contract');
}

export class FlowToolClient {
  constructor(private readonly transport: FlowToolTransport) {}

  async discover() {
    return parseFlowToolCatalog(await this.transport.request({ method: 'GET', path: '/api/v1/flow-tools' }));
  }

  async invoke(selected: FlowToolCatalogEntryV1, input: unknown, options: FlowToolInvocationOptions): Promise<FlowToolRunV1> {
    const entry = parseFlowToolEntry(selected);
    // Schema validation precedes ALL transport calls, including credential access.
    const validated = validateFlowToolInput(entry.manifest, input);
    flowToolOperationKey(options.idempotencyKey);
    const mode = options.mode ?? 'async';
    const waitMs = options.waitMs ?? 0;
    if (!['async', 'sync'].includes(mode) || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 25_000
      || (mode === 'async' && waitMs !== 0)) throw new FlowToolError('invalid_contract');
    const inputDigest = flowToolInputDigest(validated);
    const body = {
      api_version: 1, flow: `${entry.manifest.flow.name}@${entry.manifest.flow.digest}`,
      deployment_id: entry.deployment_id, manifest_digest: entry.manifest.digest,
      input: validated, input_digest: inputDigest, mode, wait_ms: waitMs,
    };
    const run = parseFlowToolRun(await this.transport.request({
      method: 'POST', path: `/api/v1/flow-tools/${entry.manifest.name}/invoke`, body, idempotencyKey: options.idempotencyKey,
    }), entry);
    if (run.input_digest !== inputDigest) throw new FlowToolError('invalid_contract');
    return run;
  }

  async status(selected: FlowToolCatalogEntryV1, receipt: FlowToolRunV1): Promise<FlowToolRunV1> {
    const entry = parseFlowToolEntry(selected), run = parseFlowToolRun(receipt, entry);
    return parseFlowToolRun(await this.transport.request({ method: 'GET', path: run.status_url }), entry, run);
  }

  async *events(selected: FlowToolCatalogEntryV1, receipt: FlowToolRunV1, after = 0): AsyncIterable<FlowToolEventV1> {
    const run = parseFlowToolRun(receipt, parseFlowToolEntry(selected));
    if (!Number.isSafeInteger(after) || after < 0) throw new FlowToolError('invalid_contract');
    let cursor = after;
    for await (const raw of this.transport.events(run.events_url, after)) {
      const event = parseFlowToolEvent(raw, run, cursor);
      cursor = event.sequence;
      yield event;
      if (event.type === 'run.terminal') return;
    }
  }

  async evidence(selected: FlowToolCatalogEntryV1, receipt: FlowToolRunV1) {
    const run = parseFlowToolRun(receipt, parseFlowToolEntry(selected));
    const raw = snapshotJsonValue(await this.transport.request({ method: 'GET', path: run.evidence_url }), 'flow tool evidence', FLOW_TOOL_LIMITS);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).sort().join(',') !== 'api_version,evidence,run_id'
      || raw.api_version !== 1 || raw.run_id !== run.run_id) throw new FlowToolError('invalid_contract');
    const evidence = parseFlowToolEvidence(raw.evidence, run.flow_digest);
    if (run.terminal !== null && canonicalize(evidence) !== canonicalize(run.terminal.evidence)) throw new FlowToolError('invalid_contract');
    return evidence;
  }

  cancel(selected: FlowToolCatalogEntryV1, receipt: FlowToolRunV1, key: string) {
    return this.command(selected, receipt, '/cancel', key, { api_version: 1 });
  }
  resume(selected: FlowToolCatalogEntryV1, receipt: FlowToolRunV1, key: string) {
    return this.command(selected, receipt, '/resume', key, { api_version: 1 });
  }
  answer(selected: FlowToolCatalogEntryV1, receipt: FlowToolRunV1, waitId: string, approved: boolean, key: string) {
    toolId(waitId);
    if (typeof approved !== 'boolean') throw new FlowToolError('invalid_contract');
    // No answered_by claim: the server derives/audits the authenticated human actor.
    return this.command(selected, receipt, `/human/${waitId}/answer`, key, { api_version: 1, input: { approved } });
  }
  private async command(selected: FlowToolCatalogEntryV1, receipt: FlowToolRunV1, suffix: string, key: string, body: unknown) {
    const entry = parseFlowToolEntry(selected), run = parseFlowToolRun(receipt, entry);
    flowToolOperationKey(key);
    return parseFlowToolRun(await this.transport.request({
      method: 'POST', path: `${run.status_url}${suffix}`, idempotencyKey: key, body,
    }), entry, run);
  }
}
