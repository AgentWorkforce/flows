// The entry vocabulary `flows logs --step` renders, and the pure helpers both
// provider parsers need.
//
// This module is a leaf: it imports nothing, so `cloud-transcript.ts` (the
// public entry point and the Claude vocabulary) and `cloud-transcript-codex.ts`
// can both depend on it without either depending on the other.
//
// The entry union is a public TypeScript API — `index.ts` re-exports it and
// `flows logs --json` emits it. Everything added for Codex is either a new
// member of the union or an optional field, so a Claude entry serializes to
// exactly the bytes it serialized to before. A consumer switching
// exhaustively over `kind` must still add the new members.

export interface TranscriptAttempt {
  kind: 'attempt';
  attempt: number | null;
  bytes: number | null;
  truncated: boolean;
}

export interface TranscriptAttemptOmitted {
  kind: 'attempt_omitted';
  attempt: number | null;
  bytes: number | null;
}

export interface TranscriptInit {
  kind: 'init';
  model: string | null;
  version: string | null;
  permission_mode: string | null;
  tools: number | null;
  mcp_servers: number | null;
  session_id: string | null;
}

export interface TranscriptMessage {
  kind: 'message';
  role: 'assistant' | 'user';
  text: string;
  /** A frame carrying `parent_tool_use_id`: a subagent's turn, not the main one. */
  nested: boolean;
  /**
   * Codex only, and only when false: the message was read off an
   * `item.started`/`item.updated` snapshot that never completed, so the text
   * is what had been written so far and not the whole of it.
   */
  complete?: boolean;
}

export interface TranscriptThinking {
  kind: 'thinking';
  /** The count only. A thinking block's text and signature never reach the page. */
  chars: number;
  nested: boolean;
}

/**
 * The Codex half of a tool call. Present on an entry parsed from a Codex
 * `command_execution` or `mcp_tool_call` item and absent on every Claude
 * entry, which is what the renderer discriminates on: a Codex failure has to
 * keep its exit code, its status and its result size on the same line, where
 * Claude's renderer replaces the size with `ERROR`.
 */
export interface TranscriptToolCodex {
  /** The call's position among the calls of its attempt, counted from 1. */
  seq: number;
  /** `in_progress`, `completed` or `failed`, as the item reported it. */
  status: string | null;
  /** Null when the item carried no exit code — not the same fact as exit 0. */
  exit_code: number | null;
  /** Redacted, then bounded. Null when the item carried no output field at all. */
  output_excerpt: string | null;
  /** True when a character or line bound cut the excerpt. */
  output_truncated: boolean;
  /** False when no `item.completed` ever arrived for this call. */
  complete: boolean;
  /** Redacted, then bounded. The item's own failure text. */
  error: string | null;
}

export interface TranscriptTool {
  kind: 'tool';
  name: string;
  /** What the call was aimed at: a path, a command, a pattern. Null when the input had no string. */
  target: string | null;
  /** Null when no `tool_result` answered it -- not the same fact as a zero-byte result. */
  result_chars: number | null;
  is_error: boolean;
  nested: boolean;
  /** Codex only. Its presence is what tells the renderer which shape to print. */
  codex?: TranscriptToolCodex;
}

/** One `apply_patch` item: file activity, not a tool call, so it is not numbered. */
export interface TranscriptFileChange {
  kind: 'file_change';
  changes: Array<{ path: string | null; change: string | null }>;
  /** Change elements that were not objects. Counted rather than dropped. */
  malformed: number;
  status: string | null;
  complete: boolean;
}

export interface TranscriptThread {
  kind: 'thread';
  thread_id: string | null;
}

export interface TranscriptTurn {
  kind: 'turn';
  phase: 'started' | 'completed' | 'failed';
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read: number | null;
  cache_creation: number | null;
  reasoning_out: number | null;
}

/** A `turn.failed`, a top-level `error` frame, or an `error` item. */
export interface TranscriptError {
  kind: 'error';
  /** The frame this came from, so the reader knows what failed. */
  source: string;
  message: string;
}

export interface TranscriptResult {
  kind: 'result';
  is_error: boolean;
  subtype: string | null;
  duration_ms: number | null;
  num_turns: number | null;
  total_cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read: number | null;
  cache_creation: number | null;
}

export interface TranscriptUnknown {
  kind: 'unknown';
  type: string;
  chars: number;
}

export interface TranscriptUnparsed {
  kind: 'unparsed';
  text: string;
}

export type TranscriptEntry =
  | TranscriptAttempt | TranscriptAttemptOmitted | TranscriptInit | TranscriptMessage
  | TranscriptThinking | TranscriptTool | TranscriptFileChange | TranscriptThread
  | TranscriptTurn | TranscriptError | TranscriptResult | TranscriptUnknown | TranscriptUnparsed;

export interface ParsedTranscript {
  entries: TranscriptEntry[];
  /** How many attempts said their head was cut to fit the log cap. */
  truncated_attempts: number;
  /** How many attempts were dropped whole to fit the log cap. */
  omitted_attempts: number;
  /**
   * False when the log carried no frame either vocabulary this module knows --
   * a v1 plain-terminal sandbox log, say. The caller prints it raw rather than
   * claiming an empty transcript.
   */
  stream_json: boolean;
}

/** A command, an argument list or a `server/tool` pair on one line. */
export const TARGET_MAX_CHARS = 160;

/** A command's or a tool's output excerpt: enough to read, bounded either way. */
export const OUTPUT_MAX_CHARS = 1000;
export const OUTPUT_MAX_LINES = 10;

/** Provider-supplied failure text. Prose from the agent is the only uncapped string. */
export const ERROR_MAX_CHARS = 1000;

/** A path stays identifiable, so it is bounded far above a one-line target. */
export const PATH_MAX_CHARS = 200;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Collapse to one line and bound it; a tool input can be a whole file body. */
export function oneLine(text: string, limit = TARGET_MAX_CHARS): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

export function thousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

/** Terminal control characters never reach the page, wherever the text came from. */
export function safe(text: string): string {
  return text.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/gu, '?');
}

/** One rule with a label, the way an attempt boundary reads. */
export function separator(label: string): string {
  return `── ${label} ${'─'.repeat(Math.max(2, 68 - label.length))}`;
}
