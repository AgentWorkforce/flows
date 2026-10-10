import type { FlowToolDigest, FlowToolManifestV1 } from './flow-tool-manifest.js';
import type { FlowToolJson, FlowToolObjectSchema } from './flow-tool-schema.js';
import type { Spend } from './run-state.js';
import { snapshotJsonValue } from './json-value.js';
import { FLOW_TOOL_LIMITS } from './flow-tool-schema.js';

export const FLOW_TOOL_API_VERSION = 1 as const;
export const FLOW_TOOL_TERMINAL_REASONS = [
  'success', 'gate_failed', 'model_failed', 'agent_failed', 'budget_exceeded',
  'human_rejected', 'human_timeout', 'canceled', 'execution_failed',
] as const;
export type FlowToolTerminalReason = typeof FLOW_TOOL_TERMINAL_REASONS[number];
export type FlowToolRunState = 'accepted' | 'running' | 'parked' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

/** Operator-owned, server-authorized read-only revision; never generated from run input. */
export interface FlowToolCatalogEntryV1 {
  readonly manifest: FlowToolManifestV1;
  readonly deployment_id: string;
  readonly read_only: true;
  readonly effects: readonly string[];
  readonly requires_human: readonly string[];
  readonly business_verdicts: readonly string[];
  readonly budget: Readonly<{ max_tokens: number; max_dollars: string | null; max_wallclock_ms: number }>;
}
export interface FlowToolCatalogV1 {
  readonly api_version: 1;
  readonly tools: readonly FlowToolCatalogEntryV1[];
}
export interface FlowToolEvidenceV1 {
  readonly journal_digest: FlowToolDigest;
  readonly flow_digest: FlowToolDigest;
  readonly artifacts: readonly Readonly<{ name: string; ref: string; media_type: string }>[];
  readonly redacted_transcript_refs: readonly string[];
}
export interface FlowToolTerminalV1 {
  readonly terminal_reason: FlowToolTerminalReason;
  readonly business_verdict: string | null;
  readonly result: Readonly<Record<string, FlowToolJson>> | null;
  readonly gates: readonly Readonly<{ name: string; status: 'pass' | 'fail' | 'skipped'; evidence_ref: string }>[];
  readonly evidence: FlowToolEvidenceV1;
  readonly spend: Readonly<Spend>;
}
/** Accepted is durable admission, never successful execution; terminal is null until finished. */
export interface FlowToolRunV1 {
  readonly api_version: 1;
  readonly accepted: true;
  readonly run_id: string;
  readonly tool_name: string;
  readonly deployment_id: string;
  readonly manifest_digest: FlowToolDigest;
  readonly flow_digest: FlowToolDigest;
  readonly input_digest: FlowToolDigest;
  readonly state: FlowToolRunState;
  readonly sequence: number;
  readonly status_url: string;
  readonly events_url: string;
  readonly evidence_url: string;
  readonly cancel_url: string;
  readonly resume_url: string;
  readonly terminal: FlowToolTerminalV1 | null;
}
export interface FlowToolEventV1 {
  readonly api_version: 1;
  readonly run_id: string;
  readonly flow_digest: FlowToolDigest;
  readonly sequence: number;
  readonly type: 'run.accepted' | 'run.state_changed' | 'step.completed' | 'human.required' | 'run.terminal';
  readonly state: FlowToolRunState;
  readonly step_id?: string;
  readonly wait_id?: string;
  readonly terminal_reason?: FlowToolTerminalReason;
}
export interface FlowToolInvokeRequestV1 {
  readonly api_version: 1;
  readonly flow: string;
  readonly deployment_id: string;
  readonly manifest_digest: FlowToolDigest;
  readonly input: Readonly<Record<string, FlowToolJson>>;
  /** Assertion only: admission MUST recompute this from schema-validated canonical input. */
  readonly input_digest: FlowToolDigest;
  readonly mode: 'async' | 'sync';
  readonly wait_ms: number;
}
export type FlowToolFailureCode = 'invalid_contract' | 'not_authorized' | 'not_found'
  | 'idempotency_conflict' | 'unsupported' | 'unavailable' | 'transport_error';
export class FlowToolError extends Error {
  constructor(readonly code: FlowToolFailureCode) {
    // Never interpolate remote bodies, model input, bearer tokens or transport errors.
    super(`Flow Tool ${code}${code === 'transport_error' ? ': admission or command outcome may be unknown; observation failure does not cancel a run' : ''}`);
    this.name = 'FlowToolError';
  }
}

const text = { type: 'string', minLength: 1, maxLength: 128 };
const digest = { type: 'string', minLength: 71, maxLength: 71 };
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const positive = { ...integer, minimum: 1 };
const strings = { type: 'array', items: text, maxItems: 64, uniqueItems: true };
const state = { enum: ['accepted', 'running', 'parked', 'cancelling', 'completed', 'failed', 'cancelled'] };
function object(properties: Record<string, unknown>, required = Object.keys(properties)) {
  return snapshotJsonValue({ type: 'object', properties, required, additionalProperties: false },
    'flow tool protocol schema', FLOW_TOOL_LIMITS) as FlowToolObjectSchema;
}
export const FLOW_TOOL_EVIDENCE_SCHEMA = object({
  journal_digest: digest, flow_digest: digest,
  artifacts: { type: 'array', maxItems: 128, items: object({ name: text, ref: text, media_type: text }) },
  redacted_transcript_refs: strings,
}) as FlowToolObjectSchema;
const terminal = object({
  terminal_reason: { enum: FLOW_TOOL_TERMINAL_REASONS },
  business_verdict: { type: ['string', 'null'], minLength: 1, maxLength: 128 },
  result: { type: ['object', 'null'] },
  gates: { type: 'array', maxItems: 128, items: object({ name: text, status: { enum: ['pass', 'fail', 'skipped'] }, evidence_ref: text }) },
  evidence: FLOW_TOOL_EVIDENCE_SCHEMA,
  spend: object({ tokens_in: integer, tokens_out: integer, dollars: text, dollars_unmetered: { type: 'boolean' } }),
});
/** Async adapters return this envelope, NOT the flow's eventual business-result schema. */
export const FLOW_TOOL_RUN_SCHEMA = object({
  api_version: { const: 1 }, accepted: { const: true }, run_id: text, tool_name: text,
  deployment_id: text, manifest_digest: digest, flow_digest: digest, input_digest: digest,
  state, sequence: integer,
  status_url: { type: 'string' }, events_url: { type: 'string' }, evidence_url: { type: 'string' },
  cancel_url: { type: 'string' }, resume_url: { type: 'string' },
  terminal: { anyOf: [{ type: 'null' }, terminal] },
}) as FlowToolObjectSchema;
export const FLOW_TOOL_CATALOG_SCHEMA = object({
  api_version: { const: 1 },
  tools: { type: 'array', maxItems: 64, items: object({
    manifest: { type: 'object' }, deployment_id: text, read_only: { const: true },
    effects: strings, requires_human: strings,
    business_verdicts: { ...strings, minItems: 1 },
    budget: object({ max_tokens: positive, max_dollars: { type: ['string', 'null'] }, max_wallclock_ms: positive }),
  }) },
}) as FlowToolObjectSchema;
export const FLOW_TOOL_EVENT_SCHEMA = object({
  api_version: { const: 1 }, run_id: text, flow_digest: digest, sequence: positive,
  type: { enum: ['run.accepted', 'run.state_changed', 'step.completed', 'human.required', 'run.terminal'] },
  state, step_id: text, wait_id: text, terminal_reason: { enum: FLOW_TOOL_TERMINAL_REASONS },
}, ['api_version', 'run_id', 'flow_digest', 'sequence', 'type', 'state']) as FlowToolObjectSchema;

export const FLOW_TOOL_INVOKE_SCHEMA = object({
  api_version: { const: 1 }, flow: { type: 'string', minLength: 73, maxLength: 200 },
  deployment_id: text, manifest_digest: digest, input_digest: digest,
  input: { type: 'object' }, mode: { enum: ['async', 'sync'] },
  wait_ms: { type: 'integer', minimum: 0, maximum: 25000 },
}) as FlowToolObjectSchema;
export const FLOW_TOOL_COMMAND_SCHEMA = object({ api_version: { const: 1 } }) as FlowToolObjectSchema;
export const FLOW_TOOL_ANSWER_SCHEMA = object({
  api_version: { const: 1 }, input: object({ approved: { type: 'boolean' } }),
}) as FlowToolObjectSchema;
export const FLOW_TOOL_ERROR_SCHEMA = object({
  api_version: { const: 1 }, code: { enum: ['invalid_contract', 'not_authorized', 'not_found', 'idempotency_conflict', 'unsupported', 'unavailable'] },
}) as FlowToolObjectSchema;
