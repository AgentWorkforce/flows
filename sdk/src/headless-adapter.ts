import type { CliAdapterKind } from './cli-adapter.js';

/** Tokens and money reported by a provider, normalized for the journal boundary. */
export interface HeadlessUsage {
  tokens_in: number;
  tokens_out: number;
  dollars: string;
}

/** Provider evidence that belongs to an agent step, not to a wrapper script. */
export interface HeadlessResult {
  finalText: string;
  trajectory: unknown[];
  usage?: HeadlessUsage;
  sessionId?: string;
  subagents?: unknown;
}

/** Closed SDK-owned provider contract; custom wrappers keep their v1 session. */
export interface HeadlessAdapter {
  kind: 'claude' | 'codex' | 'grok';
  parse(stdout: string): HeadlessResult;
}

const HEADLESS_ADAPTERS: ReadonlyMap<HeadlessAdapter['kind'], HeadlessAdapter> = new Map<
  HeadlessAdapter['kind'], HeadlessAdapter
>([
  ['claude', { kind: 'claude', parse: parseClaude }],
  ['codex', { kind: 'codex', parse: parseCodex }],
  ['grok', { kind: 'grok', parse: parseGrok }],
]);

export function headlessAdapter(kind: CliAdapterKind): HeadlessAdapter | undefined {
  return kind === 'relayflows-wrapper-v1' ? undefined : HEADLESS_ADAPTERS.get(kind);
}

/** Parse a successful provider's structured response. Empty finals are failures. */
export function parseHeadlessOutput(kind: CliAdapterKind, stdout: string): HeadlessResult {
  const adapter = headlessAdapter(kind);
  if (adapter === undefined) throw new Error('custom wrapper output is not a provider headless stream');
  return adapter.parse(stdout);
}

function parseClaude(stdout: string): HeadlessResult {
  const events = parseJsonLines(stdout, 'Claude');
  const result = [...events].reverse().find(isClaudeResult);
  if (result === undefined || typeof result.result !== 'string' || result.result.trim() === '') {
    throw new Error('Claude completed without a readable final result message.');
  }
  if (result.is_error === true) throw new Error('Claude reported an error result.');
  return {
    finalText: result.result,
    trajectory: events,
    ...(usageFrom(result.usage, result.total_cost_usd)),
    ...(stringField(result, 'session_id', 'Claude') === undefined
      ? {} : { sessionId: stringField(result, 'session_id', 'Claude') }),
    ...(result.subagent_stats === undefined ? {} : { subagents: result.subagent_stats }),
  };
}

function parseCodex(stdout: string): HeadlessResult {
  const events = parseJsonLines(stdout, 'Codex');
  const thread = events.find((event) => event.type === 'thread.started');
  const messages = events.filter(isCodexAgentMessage);
  const final = messages.at(-1);
  if (final === undefined) throw new Error('Codex completed without a readable final agent message.');
  const completed = [...events].reverse().find((event) => event.type === 'turn.completed');
  return {
    finalText: final.item.text,
    trajectory: events,
    ...(completed === undefined ? {} : usageFrom(completed.usage, undefined)),
    ...(thread !== undefined && typeof thread.thread_id === 'string' ? { sessionId: thread.thread_id } : {}),
  };
}

function parseGrok(stdout: string): HeadlessResult {
  const value = parseJson(stdout.trim(), 'Grok');
  if (typeof value.text !== 'string' || value.text.trim() === '') {
    throw new Error('Grok completed without a readable final text message.');
  }
  return {
    finalText: value.text,
    trajectory: [value],
    ...(usageFrom(value.usage, value.total_cost_usd)),
    ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
    ...(value.subagents === undefined ? {} : { subagents: value.subagents }),
  };
}

function parseJsonLines(stdout: string, provider: string): Record<string, unknown>[] {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new Error(`${provider} produced no structured events.`);
  return lines.map((line, index) => parseJson(line, `${provider} event ${index + 1}`));
}

function parseJson(source: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`${label} emitted malformed structured JSON.`);
  }
  if (!isRecord(parsed)) throw new Error(`${label} emitted a non-object structured event.`);
  return parsed;
}

function isClaudeResult(value: Record<string, unknown>): value is Record<string, unknown> & { result: string } {
  return value.type === 'result';
}

function isCodexAgentMessage(value: Record<string, unknown>): value is Record<string, unknown> & { item: { text: string } } {
  return value.type === 'item.completed'
    && isRecord(value.item)
    && value.item.type === 'agent_message'
    && typeof value.item.text === 'string'
    && value.item.text.trim() !== '';
}

function usageFrom(value: unknown, dollars: unknown): { usage?: HeadlessUsage } {
  if (!isRecord(value)) return {};
  const tokensIn = numberField(value, 'input_tokens') ?? numberField(value, 'inputTokens');
  const tokensOut = numberField(value, 'output_tokens') ?? numberField(value, 'outputTokens');
  if (tokensIn === undefined || tokensOut === undefined) return {};
  return {
    usage: {
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      dollars: decimalString(dollars) ?? '0',
    },
  };
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const number = value[key];
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function decimalString(value: unknown): string | undefined {
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return value;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return String(value);
  return undefined;
}

function stringField(value: Record<string, unknown>, key: string, _provider: string): string | undefined {
  return typeof value[key] === 'string' ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
