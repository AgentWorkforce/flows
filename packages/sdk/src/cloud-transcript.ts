// Rendering an agent step's transcript JSONL for a terminal.
//
// The frames are what the harness wrote -- Claude Code's `stream-json`, or
// `codex exec --json` -- wrapped by the `relayflow.attempt` markers the v2
// executor interleaves when it assembles one log out of several attempts.
// The Claude frame vocabulary read here is the one Cloud's dashboard renderer
// reads (cloud#3847, `packages/web/lib/workflows/agent-transcript.ts`) -- the
// same shapes, so the CLI and the dashboard agree about what a run did. The
// implementation is not shared: this package cannot import from the Cloud app,
// and a CLI that had to be deployed in step with a dashboard would be worse
// than one that does not. The Codex vocabulary lives in
// `cloud-transcript-codex.ts`; dispatch is per frame, not per provider, so a
// log that mixes them stays honest rather than being forced into a guess.
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

import {
  CODEX_FRAME_TYPES, codexFrame, indexCodexItems, renderCodexEntry, type CodexState,
} from './cloud-transcript-codex.js';
import {
  TARGET_MAX_CHARS, isRecord, num, oneLine, safe, separator, str, thousands,
  type ParsedTranscript, type TranscriptEntry,
} from './cloud-transcript-types.js';
import { redact } from './redact.js';

export type {
  ParsedTranscript, TranscriptEntry, TranscriptAttempt, TranscriptAttemptOmitted, TranscriptError,
  TranscriptFileChange, TranscriptInit, TranscriptMessage, TranscriptResult, TranscriptThinking,
  TranscriptThread, TranscriptTool, TranscriptToolCodex, TranscriptTurn, TranscriptUnknown,
  TranscriptUnparsed,
} from './cloud-transcript-types.js';

/**
 * Which input field names a tool call. Order matters: the first present
 * non-empty string wins. Same list, same order as cloud#3847's
 * `ARGUMENT_KEYS`, so a call reads the same in the terminal and the dashboard.
 */
const TARGET_KEYS = [
  'file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'query',
  'prompt', 'description', 'subagent_type',
] as const;

/**
 * `clean` runs before `oneLine`, not after, and the order is load-bearing.
 *
 * `redact` scrubs a secret by matching the whole value: an env value longer
 * than the 160-character cap, truncated first, no longer matches anything and
 * survives as a prefix — which for a credential is not a safer amount of it.
 * Redact the full string, then bound what is left.
 */
function toolTarget(input: unknown, clean: (text: string) => string): string | null {
  if (!isRecord(input)) return null;
  for (const key of TARGET_KEYS) {
    const value = str(input[key]);
    if (value !== null) return oneLine(clean(value), TARGET_MAX_CHARS);
  }
  // An unfamiliar tool still shows something rather than nothing.
  for (const value of Object.values(input)) {
    const text = str(value);
    if (text !== null) return oneLine(clean(text), TARGET_MAX_CHARS);
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
  const codexIndex = indexCodexItems(raw);
  const codexState: CodexState = { seq: 0 };
  const entries: TranscriptEntry[] = [];
  let truncatedAttempts = 0;
  let omittedAttempts = 0;
  let streamJson = false;
  const clean = (text: string): string => redact(text, env);

  for (const [index, { frame, line }] of raw.entries()) {
    if (frame === undefined || !isRecord(frame)) {
      entries.push({ kind: 'unparsed', text: clean(line) });
      continue;
    }
    const type = str(frame['type']);
    if (type === 'relayflow.attempt') {
      streamJson = true;
      // Calls are numbered within an attempt, so a second attempt starts over.
      codexState.seq = 0;
      const truncated = frame['truncated'] === true;
      if (truncated) truncatedAttempts += 1;
      entries.push({ kind: 'attempt', attempt: num(frame['attempt']), bytes: num(frame['bytes']), truncated });
      continue;
    }
    if (type === 'relayflow.attempt.omitted') {
      streamJson = true;
      codexState.seq = 0;
      omittedAttempts += 1;
      entries.push({ kind: 'attempt_omitted', attempt: num(frame['attempt']), bytes: num(frame['bytes']) });
      continue;
    }
    if (type !== null && CODEX_FRAME_TYPES.has(type)) {
      streamJson = true;
      entries.push(...(codexFrame(frame, type, index, codexIndex, codexState, clean, line) ?? []));
      continue;
    }
    if (type === 'system' && frame['subtype'] === 'init') {
      streamJson = true;
      const tools = frame['tools'];
      const servers = frame['mcp_servers'];
      // Every string here is the harness's, not this client's, and a harness
      // reports what it was configured with. `clean` on all of them rather
      // than on the ones that look like free text: which field a credential
      // lands in is not something this parser gets to assume.
      const cleanOrNull = (value: string | null): string | null => value === null ? null : clean(value);
      entries.push({
        kind: 'init',
        model: cleanOrNull(str(frame['model'])),
        version: cleanOrNull(str(frame['claude_code_version']) ?? str(frame['version'])),
        permission_mode: cleanOrNull(str(frame['permissionMode']) ?? str(frame['permission_mode'])),
        tools: Array.isArray(tools) ? tools.length : num(frame['tools_count']),
        mcp_servers: Array.isArray(servers) ? servers.length : num(frame['mcp_servers_count']),
        session_id: cleanOrNull(str(frame['session_id'])),
      });
      continue;
    }
    if (type === 'assistant' || type === 'user') {
      streamJson = true;
      const message = isRecord(frame['message']) ? frame['message'] : null;
      if (message === null) { entries.push({ kind: 'unknown', type: clean(type), chars: line.length }); continue; }
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
          // The name is model-supplied too — a hallucinated or malformed call
          // can carry anything there — so it is redacted like the target.
          entries.push({
            kind: 'tool',
            name: clean(str(block['name']) ?? 'unknown'),
            target: toolTarget(block['input'], clean),
            result_chars: answer === undefined ? null : answer.chars,
            is_error: answer?.isError === true,
            nested,
          });
        } else if (blockType !== 'tool_result') {
          entries.push({ kind: 'unknown', type: clean(blockType ?? 'block'), chars: JSON.stringify(block).length });
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
        subtype: str(frame['subtype']) === null ? null : clean(str(frame['subtype'])!),
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
    entries.push({ kind: 'unknown', type: clean(type ?? 'frame'), chars: line.length });
  }
  return { entries, truncated_attempts: truncatedAttempts, omitted_attempts: omittedAttempts, stream_json: streamJson };
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function dollars(value: number): string {
  return `$${value.toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '')}`;
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
    // A Codex tool call carries its exit code, its status and its result size
    // on one line, which the Claude shape below has no room for; everything
    // the Codex vocabulary owns is rendered there.
    const codex = renderCodexEntry(entry);
    if (codex !== undefined) { lines.push(...codex); continue; }
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
        const state = entry.complete === false ? ' (incomplete)' : '';
        const who = `${entry.role}${entry.nested ? ' (subagent)' : ''}${state}`;
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
