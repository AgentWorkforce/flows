// Persisted CONFORMANCE FIXTURE, not Cloud admission or a production durable ledger.
// Synchronous file operations serialize this one-process fixture only. Production
// must use transactional scoped uniqueness + durable launch reconciliation.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createFlowToolManifest } from '../src/flow-tool-manifest.js';
import { FlowToolError, type FlowToolCatalogEntryV1, type FlowToolRunV1, type FlowToolEventV1 } from '../src/flow-tool-contract.js';
import { flowToolRunLinks, parseFlowToolInvocation } from '../src/flow-tool-wire.js';
import type { FlowToolRequest, FlowToolTransport } from '../src/flow-tool-client.js';
import { sha256 } from '../src/bundle.js';
import { canonicalize } from '../src/canonical.js';

export const entry: FlowToolCatalogEntryV1 = {
  manifest: createFlowToolManifest({
    name: 'review_pr', description: 'Read-only review; a hold is not approval.',
    flow: { name: 'review-pr', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` },
    inputSchema: { type: 'object', properties: { pr: { type: 'integer', minimum: 1 } }, required: ['pr'], additionalProperties: false },
    resultSchema: { type: 'object', properties: { findings: { type: 'integer', minimum: 0 } }, required: ['findings'], additionalProperties: false },
  }),
  deployment_id: 'deployment_1', read_only: true, effects: ['github:read'], requires_human: [],
  business_verdicts: ['pass', 'hold'], budget: { max_tokens: 1000, max_dollars: '1.00', max_wallclock_ms: 10000 },
};
export const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
interface Stored {
  principal: string;
  run: FlowToolRunV1;
  events: FlowToolEventV1[];
  commands: Record<string, string>;
}
type Ledger = Record<string, Stored>;
export class FixtureControlPlane implements FlowToolTransport {
  calls: FlowToolRequest[] = [];
  loseNextAdmissionResponse = false;
  constructor(readonly path: string, readonly principal = 'tenant-1/principal-1', readonly authorized = true) {}
  private load(): Ledger { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {}; }
  private save(ledger: Ledger) { writeFileSync(this.path, JSON.stringify(ledger)); }
  get count(): number { return Object.keys(this.load()).length; }
  private lookup(ledger: Ledger, runId: string) {
    const stored = Object.values(ledger).find(value => value.run.run_id === runId && value.principal === this.principal);
    if (!this.authorized || stored === undefined) throw new FlowToolError('not_authorized');
    return stored;
  }
  async request(request: FlowToolRequest): Promise<unknown> {
    this.calls.push(copy(request));
    if (request.path === '/api/v1/flow-tools') return { api_version: 1, tools: this.authorized ? [entry] : [] };
    if (!this.authorized) throw new FlowToolError('not_authorized');
    const ledger = this.load();
    if (request.path === '/api/v1/flow-tools/review_pr/invoke') {
      const body = parseFlowToolInvocation(request.body, entry);
      const key = sha256(canonicalize([this.principal, entry.deployment_id, entry.manifest.flow.digest, request.idempotencyKey]));
      const old = ledger[key];
      if (old) {
        if (old.run.input_digest !== body.input_digest) throw new FlowToolError('idempotency_conflict');
        return copy(old.run);
      }
      const runId = `run_${key.slice(0, 32)}`;
      const run: FlowToolRunV1 = {
        api_version: 1, accepted: true, run_id: runId, tool_name: entry.manifest.name,
        deployment_id: entry.deployment_id, manifest_digest: entry.manifest.digest,
        flow_digest: entry.manifest.flow.digest, input_digest: body.input_digest,
        state: 'accepted', sequence: 1, terminal: null, ...flowToolRunLinks(runId),
      };
      ledger[key] = { principal: this.principal, run, commands: {}, events: [{
        api_version: 1, run_id: runId, flow_digest: run.flow_digest, sequence: 1, type: 'run.accepted', state: 'accepted',
      }] };
      this.save(ledger);
      if (this.loseNextAdmissionResponse) { this.loseNextAdmissionResponse = false; throw new FlowToolError('transport_error'); }
      return copy(run);
    }
    const match = request.path.match(/^\/api\/v1\/flow-runs\/([^/]+)(.*)$/)!;
    const stored = this.lookup(ledger, match[1]!);
    if (match[2] === '/evidence') return { api_version: 1, run_id: stored.run.run_id, evidence: stored.run.terminal?.evidence };
    if (request.method === 'POST') {
      const signature = canonicalize([match[2], request.body]);
      const old = stored.commands[request.idempotencyKey!];
      if (old !== undefined && old !== signature) throw new FlowToolError('idempotency_conflict');
      stored.commands[request.idempotencyKey!] = signature;
      if (match[2] === '/cancel' && stored.run.terminal === null) this.finish(stored, 'canceled');
      this.save(ledger);
    }
    return copy(stored.run);
  }
  complete(runId: string) {
    const ledger = this.load();
    this.finish(this.lookup(ledger, runId), 'success');
    this.save(ledger);
  }
  private finish(stored: Stored, reason: 'success' | 'canceled') {
    const run = stored.run;
    stored.run = { ...run, sequence: run.sequence + 1, state: reason === 'success' ? 'completed' : 'cancelled', terminal: {
      terminal_reason: reason, business_verdict: reason === 'success' ? 'hold' : null,
      result: reason === 'success' ? { findings: 1 } : null,
      gates: [{ name: 'review', status: 'fail', evidence_ref: 'artifact_1' }],
      evidence: { journal_digest: `sha256:${'b'.repeat(64)}`, flow_digest: run.flow_digest,
        artifacts: [{ name: 'review', ref: 'artifact_1', media_type: 'application/json' }], redacted_transcript_refs: [] },
      spend: { tokens_in: 20, tokens_out: 5, dollars: '0.01', dollars_unmetered: false },
    } };
    stored.events.push({ api_version: 1, run_id: run.run_id, flow_digest: run.flow_digest,
      sequence: stored.run.sequence, type: 'run.terminal', state: stored.run.state, terminal_reason: reason });
  }
  async *events(path: string, after: number) {
    const runId = path.split('/')[4]!;
    const stored = this.lookup(this.load(), runId);
    for (const event of stored.events) if (event.sequence > after) yield copy(event);
  }
}
