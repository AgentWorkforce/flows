// Rendering an agent step's transcript JSONL for a terminal.
//
// The frames are what the harness wrote (Claude Code's `stream-json`), wrapped
// by the `relayflow.attempt` markers the v2 executor interleaves when it
// assembles one log out of several attempts. The frame vocabulary read here is
// the one Cloud's dashboard renderer reads (cloud#3847,
// `packages/web/lib/workflows/agent-transcript.ts`) -- the same shapes, so the
// CLI and the dashboard agree about what a run did. The implementation is not
// shared: this package cannot import from the Cloud app, and a CLI that had to
// be deployed in step with a dashboard would be worse than one that does not.
//
// Two rules the shapes do not give you:
//
//  - Nothing is dropped. A frame this module has no opinion about is reported
//    as one line naming its type and size, and a line that is not JSON is
//    printed as written. A reader who sees fewer events than happened has been
//    lied to; `--raw` must never be the only way to find out something ran.
//  - Every string that reaches the page goes through `redact` (redact.ts) --
//    the redactor `flows status` uses. Transcript text is whatever the agent
//    printed, including anything it read out of its own environment.

import { redact } from './redact.js';

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
}

export interface TranscriptThinking {
  kind: 'thinking';
  /** The count only. A thinking block's text and signature never reach the page. */
  chars: number;
  nested: boolean;
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
  | TranscriptThinking | TranscriptTool | TranscriptResult | TranscriptUnknown | TranscriptUnparsed;

export interface ParsedTranscript {
  entries: TranscriptEntry[];
  /** How many attempts said their head was cut to fit the log cap. */
  truncated_attempts: number;
  /** How many attempts were dropped whole to fit the log cap. */
  omitted_attempts: number;
  /**
   * False when the log carried no frame this vocabulary knows -- a v1
   * plain-terminal sandbox log, say. The caller prints it raw rather than
   * claiming an empty transcript.
   */
  stream_json: boolean;
}

/**
 * Which input field names a tool call. Order matters: the first present
 * non-empty string wins. Same list, same order as cloud#3847's
 * `ARGUMENT_KEYS`, so a call reads the same in the terminal and the dashboard.
 */
const TARGET_KEYS = [
  'file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'query',
  'prompt', 'description', 'subagent_type',
] as const;

const TARGET_MAX_CHARS = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Collapse to one line and bound it; a tool input can be a whole file body. */
function oneLine(text: string, limit = TARGET_MAX_CHARS): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

function toolTarget(input: unknown): string | null {
  if (!isRecord(input)) return null;
  for (const key of TARGET_KEYS) {
    const value = str(input[key]);
    if (value !== null) return oneLine(value);
  }
  // An unfamiliar tool still shows something rather than nothing.
  for (const value of Object.values(input)) {
    const text = str(value);
    if (text !== null) return oneLine(text);
  }
  return null;
}

/** A tool result's size, never its content. */
function resultChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) if (isRecord(block)) total += str(block['text'])?.length ?? 0;
  return total;
}

/** Index every `tool_result` by the call it answers, before rendering any call. */
function indexToolResults(frames: unknown[]): Map<string, { chars: number; isError: boolean }> {
  const results = new Map<string, { chars: number; isError: boolean }>();
  for (const frame of frames) {
    if (!isRecord(frame) || frame['type'] !== 'user') continue;
    const message = isRecord(frame['message']) ? frame['message'] : null;
    if (message === null || !Array.isArray(message['content'])) continue;
    for (const block of message['content']) {
      if (!isRecord(block) || block['type'] !== 'tool_result') continue;
      const id = str(block['tool_use_id']);
      if (id === null) continue;
      results.set(id, { chars: resultChars(block['content']), isError: block['is_error'] === true });
    }
  }
  return results;
}

function messageText(message: Record<string, unknown>): string {
  const content = message['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block): block is Record<string, unknown> => isRecord(block) && block['type'] === 'text')
    .map((block) => str(block['text']) ?? '').join('');
}

/**
 * Split a transcript log into entries.
 *
 * `env` is the environment the redactor scrubs values from; a test passes an
 * empty one so its assertions do not depend on the machine.
 */
export function parseAgentTranscript(content: string, env: NodeJS.ProcessEnv = process.env): ParsedTranscript {
  const lines = content.split('\n');
  const frames: unknown[] = [];
  const raw: Array<{ frame: unknown; line: string }> = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      const frame: unknown = JSON.parse(line);
      frames.push(frame);
      raw.push({ frame, line });
    } catch {
      raw.push({ frame: undefined, line });
    }
  }
  const results = indexToolResults(frames);
  const entries: TranscriptEntry[] = [];
  let truncatedAttempts = 0;
  let omittedAttempts = 0;
  let streamJson = false;
  const clean = (text: string): string => redact(text, env);

  for (const { frame, line } of raw) {
    if (frame === undefined || !isRecord(frame)) {
      entries.push({ kind: 'unparsed', text: clean(line) });
      continue;
    }
    const type = str(frame['type']);
    if (type === 'relayflow.attempt') {
      streamJson = true;
      const truncated = frame['truncated'] === true;
      if (truncated) truncatedAttempts += 1;
      entries.push({ kind: 'attempt', attempt: num(frame['attempt']), bytes: num(frame['bytes']), truncated });
      continue;
    }
    if (type === 'relayflow.attempt.omitted') {
      streamJson = true;
      omittedAttempts += 1;
      entries.push({ kind: 'attempt_omitted', attempt: num(frame['attempt']), bytes: num(frame['bytes']) });
      continue;
    }
    if (type === 'system' && frame['subtype'] === 'init') {
      streamJson = true;
      const tools = frame['tools'];
      const servers = frame['mcp_servers'];
      entries.push({
        kind: 'init',
        model: str(frame['model']) === null ? null : clean(str(frame['model'])!),
        version: str(frame['claude_code_version']) ?? str(frame['version']),
        permission_mode: str(frame['permissionMode']) ?? str(frame['permission_mode']),
        tools: Array.isArray(tools) ? tools.length : num(frame['tools_count']),
        mcp_servers: Array.isArray(servers) ? servers.length : num(frame['mcp_servers_count']),
        session_id: str(frame['session_id']),
      });
      continue;
    }
    if (type === 'assistant' || type === 'user') {
      streamJson = true;
      const message = isRecord(frame['message']) ? frame['message'] : null;
      if (message === null) { entries.push({ kind: 'unknown', type, chars: line.length }); continue; }
      const nested = frame['parent_tool_use_id'] !== undefined && frame['parent_tool_use_id'] !== null;
      const content = message['content'];
      if (!Array.isArray(content)) {
        const text = messageText(message);
        if (text.length > 0) entries.push({ kind: 'message', role: type, text: clean(text), nested });
        continue;
      }
      // A user frame that is nothing but tool results is the answer to calls
      // already reported; reporting it again would double every tool line.
      if (type === 'user' && content.every((block) => isRecord(block) && block['type'] === 'tool_result')) continue;
      for (const block of content) {
        if (!isRecord(block)) { entries.push({ kind: 'unknown', type: 'block', chars: JSON.stringify(block).length }); continue; }
        const blockType = str(block['type']);
        if (blockType === 'text') {
          const text = str(block['text']);
          if (text !== null) entries.push({ kind: 'message', role: type, text: clean(text), nested });
        } else if (blockType === 'thinking') {
          entries.push({ kind: 'thinking', chars: str(block['thinking'])?.length ?? 0, nested });
        } else if (blockType === 'tool_use') {
          const id = str(block['id']);
          const answer = id === null ? undefined : results.get(id);
          const target = toolTarget(block['input']);
          entries.push({
            kind: 'tool',
            name: str(block['name']) ?? 'unknown',
            target: target === null ? null : clean(target),
            result_chars: answer === undefined ? null : answer.chars,
            is_error: answer?.isError === true,
            nested,
          });
        } else if (blockType !== 'tool_result') {
          entries.push({ kind: 'unknown', type: blockType ?? 'block', chars: JSON.stringify(block).length });
        }
      }
      continue;
    }
    if (type === 'result') {
      streamJson = true;
      const usage = isRecord(frame['usage']) ? frame['usage'] : null;
      entries.push({
        kind: 'result',
        is_error: frame['is_error'] === true,
        subtype: str(frame['subtype']),
        duration_ms: num(frame['duration_ms']),
        num_turns: num(frame['num_turns']),
        total_cost_usd: num(frame['total_cost_usd']),
        tokens_in: usage === null ? null : num(usage['input_tokens']),
        tokens_out: usage === null ? null : num(usage['output_tokens']),
        cache_read: usage === null ? null : num(usage['cache_read_input_tokens']),
        cache_creation: usage === null ? null : num(usage['cache_creation_input_tokens']),
      });
      continue;
    }
    entries.push({ kind: 'unknown', type: type ?? 'frame', chars: line.length });
  }
  return { entries, truncated_attempts: truncatedAttempts, omitted_attempts: omittedAttempts, stream_json: streamJson };
}

function thousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Terminal control characters never reach the page, wherever the text came from. */
function safe(text: string): string {
  return text.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/gu, '?');
}

function dollars(value: number): string {
  return `$${value.toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '')}`;
}

/** One rule with a label, the way an attempt boundary reads. */
function separator(label: string): string {
  return `── ${label} ${'─'.repeat(Math.max(2, 68 - label.length))}`;
}

/**
 * Render a parsed transcript as terminal lines.
 *
 * Prose is prose: an assistant's text is printed as it was written, wrapped in
 * nothing, because that is the part a reader is here for. Everything else is
 * one line: a tool call, a thought's size, an unrendered frame.
 */
export function renderAgentTranscript(parsed: ParsedTranscript): string[] {
  const lines: string[] = [];
  for (const entry of parsed.entries) {
    switch (entry.kind) {
      case 'attempt': {
        const size = entry.bytes === null ? '' : ` · ${thousands(entry.bytes)} bytes`;
        lines.push(separator(`attempt ${entry.attempt ?? '?'}${size}${entry.truncated ? ' · head cut to fit the log cap' : ''}`));
        break;
      }
      case 'attempt_omitted': {
        const size = entry.bytes === null ? '' : ` · ${thousands(entry.bytes)} bytes`;
        lines.push(separator(`attempt ${entry.attempt ?? '?'}${size} · dropped whole to fit the log cap`));
        break;
      }
      case 'init': {
        const facts = [
          entry.model, entry.version === null ? null : `v${entry.version}`, entry.permission_mode,
          entry.tools === null ? null : `${entry.tools} tools`,
          entry.mcp_servers === null ? null : `${entry.mcp_servers} MCP servers`,
        ].filter((fact): fact is string => fact !== null && fact.length > 0);
        lines.push(`session  ${safe(facts.join(' · '))}`);
        break;
      }
      case 'message': {
        const who = `${entry.role}${entry.nested ? ' (subagent)' : ''}`;
        const body = entry.text.split('\n');
        lines.push(`${who}:`);
        for (const line of body) lines.push(`  ${safe(line)}`);
        break;
      }
      case 'thinking':
        lines.push(`  thinking  ${thousands(entry.chars)} chars (not shown)`);
        break;
      case 'tool': {
        const size = entry.is_error ? 'ERROR'
          : entry.result_chars === null ? 'no result' : `${thousands(entry.result_chars)} chars`;
        const target = entry.target === null ? '' : `  ${safe(entry.target)}`;
        lines.push(`  tool  ${safe(entry.name)}${target}  → ${size}`);
        break;
      }
      case 'result': {
        const facts = [
          entry.duration_ms === null ? null : seconds(entry.duration_ms),
          entry.num_turns === null ? null : `${entry.num_turns} turn${entry.num_turns === 1 ? '' : 's'}`,
          entry.total_cost_usd === null ? null : dollars(entry.total_cost_usd),
          entry.tokens_in === null && entry.tokens_out === null
            ? null : `${thousands(entry.tokens_in ?? 0)} in / ${thousands(entry.tokens_out ?? 0)} out`,
          entry.cache_read === null ? null : `${thousands(entry.cache_read)} cache read`,
          entry.cache_creation === null ? null : `${thousands(entry.cache_creation)} cache write`,
        ].filter((fact): fact is string => fact !== null);
        const verdict = entry.is_error ? `error${entry.subtype === null ? '' : ` (${entry.subtype})`}` : entry.subtype ?? 'done';
        lines.push(separator(`result ${verdict}${facts.length === 0 ? '' : ` · ${facts.join(' · ')}`}`));
        break;
      }
      case 'unknown':
        lines.push(`  frame  ${safe(entry.type)} (${thousands(entry.chars)} chars, not rendered here — see --raw)`);
        break;
      case 'unparsed':
        lines.push(`  unparsed  ${safe(oneLine(entry.text, 200))}`);
        break;
    }
  }
  return lines;
}
