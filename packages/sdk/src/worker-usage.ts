import type { WorkerCliResult } from './worker-cli.js';
import { MODEL_PRICING } from './model-pricing.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function invalid(result: WorkerCliResult, detail: string): WorkerCliResult {
  return { ...result, exit_code: null, stderr_tail: `${result.stderr_tail}\n${detail}`.trim() };
}

function usageResult(result: WorkerCliResult, usage: unknown, output: unknown): WorkerCliResult {
  if (output === undefined) return invalid(result, 'Provider completion is missing its output.');
  if (!record(usage) || !count(usage.input_tokens) || !count(usage.output_tokens)) {
    return invalid(result, 'Provider completion has invalid token usage.');
  }
  return { ...result, stdout_tail: typeof output === 'string' ? output : JSON.stringify(output),
    tokens_input: usage.input_tokens, tokens_output: usage.output_tokens };
}

/** Provider envelopes are execution metadata, never the authored output. */
export function decodeProviderResult(result: WorkerCliResult, kind: 'claude' | 'codex'): WorkerCliResult {
  const frames: RecordValue[] = [];
  for (const line of result.stdout_tail.split('\n')) {
    try { const frame: unknown = JSON.parse(line); if (record(frame)) frames.push(frame); } catch { /* Plain text remains output. */ }
  }
  const terminal = [...frames].reverse().find(f => kind === 'claude' ? f.type === 'result' : f.type === 'turn.completed');
  if (terminal === undefined) return result;
  const text = kind === 'claude' ? terminal.result : frames
    .flatMap(f => f.type === 'item.completed' && record(f.item) && f.item.type === 'agent_message' && typeof f.item.text === 'string' ? [f.item.text] : []).join('\n');
  return usageResult(result, terminal.usage, text);
}

/** Optional wrapper result envelope; existing opaque text output stays valid. */
export function decodeWrapperResult(result: WorkerCliResult): WorkerCliResult {
  let value: unknown;
  try { value = JSON.parse(result.stdout_tail); } catch { return result; }
  if (!record(value) || value.protocol !== 'relayflows-agent-cli-v1-result') return result;
  return usageResult(result, value.usage, value.output);
}

export function requirePricedUsage(result: WorkerCliResult, model?: string): WorkerCliResult {
  if (model !== undefined && Object.hasOwn(MODEL_PRICING, model)
      && (result.tokens_input === undefined || result.tokens_output === undefined)) {
    return invalid(result, 'Priced model completion is missing token usage.');
  }
  return result;
}
