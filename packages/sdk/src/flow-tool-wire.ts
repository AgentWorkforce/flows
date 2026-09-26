import { canonicalize } from './canonical.js';
import { sha256 } from './bundle.js';
import { snapshotJsonValue } from './json-value.js';
import { compileFlowToolSchema, FLOW_TOOL_LIMITS, type FlowToolObjectSchema } from './flow-tool-schema.js';
import { parseFlowToolManifest, validateFlowToolInput, validateFlowToolResult, type FlowToolDigest } from './flow-tool-manifest.js';
import {
  FlowToolError, FLOW_TOOL_CATALOG_SCHEMA, FLOW_TOOL_RUN_SCHEMA, FLOW_TOOL_EVIDENCE_SCHEMA, FLOW_TOOL_EVENT_SCHEMA, FLOW_TOOL_INVOKE_SCHEMA,
  type FlowToolCatalogV1, type FlowToolCatalogEntryV1, type FlowToolRunV1, type FlowToolEventV1, type FlowToolEvidenceV1, type FlowToolInvokeRequestV1,
} from './flow-tool-contract.js';

// Compile only our fixed protocol schemas; never cache caller-controlled schemas globally.
const validators = new Map([FLOW_TOOL_CATALOG_SCHEMA, FLOW_TOOL_RUN_SCHEMA, FLOW_TOOL_EVIDENCE_SCHEMA, FLOW_TOOL_EVENT_SCHEMA, FLOW_TOOL_INVOKE_SCHEMA]
  .map(schema => [schema, compileFlowToolSchema(schema)]));
function wire<T>(value: unknown, schema: FlowToolObjectSchema): T {
  try {
    const snapshot = snapshotJsonValue(value, 'flow tool protocol', FLOW_TOOL_LIMITS);
    if (!validators.get(schema)!(snapshot)) throw new FlowToolError('invalid_contract');
    return snapshot as T;
  } catch { throw new FlowToolError('invalid_contract'); }
}
export function toolId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new FlowToolError('invalid_contract');
}
function digest(value: unknown): asserts value is FlowToolDigest {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new FlowToolError('invalid_contract');
}
function decimal(value: string): void {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) throw new FlowToolError('invalid_contract');
}
export function flowToolInputDigest(value: unknown): FlowToolDigest {
  return `sha256:${sha256(canonicalize(snapshotJsonValue(value, 'flow tool input', FLOW_TOOL_LIMITS)))}`;
}
export function parseFlowToolCatalog(value: unknown): FlowToolCatalogV1 {
  const catalog = wire<FlowToolCatalogV1>(value, FLOW_TOOL_CATALOG_SCHEMA);
  const names = new Set<string>();
  for (const entry of catalog.tools) {
    try { parseFlowToolManifest(entry.manifest); } catch { throw new FlowToolError('invalid_contract'); }
    toolId(entry.deployment_id);
    if (names.has(entry.manifest.name)) throw new FlowToolError('invalid_contract');
    names.add(entry.manifest.name);
    for (const name of [...entry.business_verdicts, ...entry.requires_human]) toolId(name);
    // Policy labels are not enforcement. The server must also bind read_only to
    // effective capabilities; this v1 client will not accept a write-enabled entry.
    if (entry.effects.some(effect => !/^[a-z][a-z0-9_-]*:read$/.test(effect))) throw new FlowToolError('invalid_contract');
    if (entry.budget.max_dollars !== null) {
      if (entry.budget.max_dollars.length > 128) throw new FlowToolError('invalid_contract');
      decimal(entry.budget.max_dollars);
    }
  }
  return catalog;
}
export function parseFlowToolEntry(value: unknown): FlowToolCatalogEntryV1 {
  return parseFlowToolCatalog({ api_version: 1, tools: [value] }).tools[0]!;
}
/** Stable discovery serialization independent of input key or catalog ordering. */
export function canonicalFlowToolCatalog(value: unknown): string {
  const catalog = parseFlowToolCatalog(value);
  return canonicalize({ api_version: 1, tools: [...catalog.tools].sort((a, b) =>
    a.manifest.name < b.manifest.name ? -1 : a.manifest.name > b.manifest.name ? 1 : 0) });
}
/** Shared admission validation; this proves a contract binding, not authorization. */
export function parseFlowToolInvocation(value: unknown, selected: FlowToolCatalogEntryV1): FlowToolInvokeRequestV1 {
  const entry = parseFlowToolEntry(selected);
  const request = wire<FlowToolInvokeRequestV1>(value, FLOW_TOOL_INVOKE_SCHEMA);
  if (request.flow !== `${entry.manifest.flow.name}@${entry.manifest.flow.digest}`
    || request.deployment_id !== entry.deployment_id || request.manifest_digest !== entry.manifest.digest
    || (request.mode === 'async' && request.wait_ms !== 0)) throw new FlowToolError('invalid_contract');
  let input: unknown;
  try { input = validateFlowToolInput(entry.manifest, request.input); } catch { throw new FlowToolError('invalid_contract'); }
  if (flowToolInputDigest(input) !== request.input_digest) throw new FlowToolError('invalid_contract');
  return request;
}
export function parseFlowToolEvidence(value: unknown, flowDigest: FlowToolDigest): FlowToolEvidenceV1 {
  const evidence = wire<FlowToolEvidenceV1>(value, FLOW_TOOL_EVIDENCE_SCHEMA);
  digest(evidence.journal_digest);
  if (evidence.flow_digest !== flowDigest) throw new FlowToolError('invalid_contract');
  const refs = new Set<string>();
  for (const artifact of evidence.artifacts) {
    toolId(artifact.name); toolId(artifact.ref);
    if (refs.has(artifact.ref) || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(artifact.media_type)) throw new FlowToolError('invalid_contract');
    refs.add(artifact.ref);
  }
  evidence.redacted_transcript_refs.forEach(toolId);
  return evidence;
}
export function flowToolRunLinks(runId: string) {
  toolId(runId);
  const path = `/api/v1/flow-runs/${runId}`;
  return { status_url: path, events_url: `${path}/events`, evidence_url: `${path}/evidence`, cancel_url: `${path}/cancel`, resume_url: `${path}/resume` };
}
export function parseFlowToolRun(value: unknown, selected: FlowToolCatalogEntryV1, previous?: FlowToolRunV1): FlowToolRunV1 {
  const run = wire<FlowToolRunV1>(value, FLOW_TOOL_RUN_SCHEMA);
  toolId(run.run_id); digest(run.input_digest);
  if (run.tool_name !== selected.manifest.name || run.deployment_id !== selected.deployment_id
    || run.manifest_digest !== selected.manifest.digest || run.flow_digest !== selected.manifest.flow.digest) throw new FlowToolError('invalid_contract');
  for (const [key, url] of Object.entries(flowToolRunLinks(run.run_id))) {
    if (run[key as keyof FlowToolRunV1] !== url) throw new FlowToolError('invalid_contract');
  }
  const terminal = ['completed', 'failed', 'cancelled'].includes(run.state);
  if (terminal !== (run.terminal !== null)) throw new FlowToolError('invalid_contract');
  if (run.terminal !== null) {
    const result = run.terminal;
    const success = result.terminal_reason === 'success';
    if (success !== (run.state === 'completed') || (run.state === 'cancelled') !== (result.terminal_reason === 'canceled')) throw new FlowToolError('invalid_contract');
    if (success) {
      if (result.business_verdict === null || !selected.business_verdicts.includes(result.business_verdict) || result.result === null) throw new FlowToolError('invalid_contract');
      try { validateFlowToolResult(selected.manifest, result.result); } catch { throw new FlowToolError('invalid_contract'); }
    } else if (result.business_verdict !== null || result.result !== null) throw new FlowToolError('invalid_contract');
    const evidence = parseFlowToolEvidence(result.evidence, run.flow_digest);
    const refs = new Set(evidence.artifacts.map(artifact => artifact.ref));
    const gateNames = new Set<string>();
    for (const gate of result.gates) {
      toolId(gate.name); toolId(gate.evidence_ref);
      if (!refs.has(gate.evidence_ref) || gateNames.has(gate.name)) throw new FlowToolError('invalid_contract');
      gateNames.add(gate.name);
    }
    decimal(result.spend.dollars);
    if (selected.budget.max_dollars !== null && result.spend.dollars_unmetered) throw new FlowToolError('invalid_contract');
  }
  if (previous !== undefined) {
    if (run.run_id !== previous.run_id || run.input_digest !== previous.input_digest || run.sequence < previous.sequence
      || (run.sequence === previous.sequence && canonicalize(run) !== canonicalize(previous))
      || (previous.terminal !== null && canonicalize(run) !== canonicalize(previous))) throw new FlowToolError('invalid_contract');
  }
  return run;
}
export function parseFlowToolEvent(value: unknown, run: FlowToolRunV1, cursor: number): FlowToolEventV1 {
  const event = wire<FlowToolEventV1>(value, FLOW_TOOL_EVENT_SCHEMA);
  if (event.run_id !== run.run_id || event.flow_digest !== run.flow_digest || event.sequence <= cursor) throw new FlowToolError('invalid_contract');
  if (event.step_id !== undefined) toolId(event.step_id);
  if (event.wait_id !== undefined) toolId(event.wait_id);
  const terminal = ['completed', 'failed', 'cancelled'].includes(event.state);
  if ((event.type === 'run.terminal') !== terminal || terminal !== (event.terminal_reason !== undefined)
    || (event.type === 'run.accepted' && event.state !== 'accepted')
    || (event.type !== 'human.required' && event.wait_id !== undefined)
    || (event.type === 'human.required' && (event.wait_id === undefined || event.state !== 'parked'))
    || (event.type === 'step.completed' && event.step_id === undefined)
    || (terminal && ((event.state === 'completed') !== (event.terminal_reason === 'success')
      || (event.state === 'cancelled') !== (event.terminal_reason === 'canceled')))) throw new FlowToolError('invalid_contract');
  return event;
}
