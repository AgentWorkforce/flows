// The Codex half of `flows logs --step`: `codex exec --json` JSONL.
//
// The vocabulary was captured, not guessed. Every frame shape read here came
// out of a real `codex exec --json` run of codex-cli 0.155.1 on 2026-09-21;
// the captures are the two fixtures under `tests/fixtures/`, and the event and
// item names are the ones the binary's own enums carry (`thread.started`,
// `turn.started`, `turn.completed`, `turn.failed`, `item.started`,
// `item.updated`, `item.completed`, `error`; items `agent_message`,
// `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`,
// `web_search`, `todo_list`, `error`). `web_search` and `todo_list` keep the
// unknown-frame placeholder: naming an item type is not the same as knowing
// which of its fields carry what, and a placeholder is honest.
//
// The two rules `cloud-transcript.ts` states hold here too. Nothing is
// dropped: an item this module cannot read becomes the placeholder line rather
// than vanishing or being reported as a success. And every provider string is
// redacted whole before it is bounded, because a truncated credential still
// matches nothing and is still most of a credential.

import {
  ERROR_MAX_CHARS, OUTPUT_MAX_CHARS, OUTPUT_MAX_LINES, PATH_MAX_CHARS, TARGET_MAX_CHARS,
  isRecord, num, oneLine, safe, separator, str, thousands,
  type TranscriptEntry, type TranscriptToolCodex,
} from './cloud-transcript-types.js';

/** Frame types that make a log a transcript this module can render. */
export const CODEX_FRAME_TYPES: ReadonlySet<string> = new Set([
  'thread.started', 'turn.started', 'turn.completed', 'turn.failed',
  'item.started', 'item.updated', 'item.completed', 'error',
]);

/** Item types whose lifecycles are matched and whose fields are read. */
const SUPPORTED_ITEMS: ReadonlySet<string> = new Set([
  'agent_message', 'reasoning', 'command_execution', 'file_change', 'mcp_tool_call', 'error',
]);

const ITEM_FRAMES: ReadonlySet<string> = new Set(['item.started', 'item.updated', 'item.completed']);

/** Calls are numbered; an `apply_patch` is file activity, not a call. */
const NUMBERED_ITEMS: ReadonlySet<string> = new Set(['command_execution', 'mcp_tool_call']);

interface Lifecycle {
  snapshots: Array<Record<string, unknown>>;
  complete: boolean;
  /** The index of the last frame of this lifecycle: where the entry is emitted. */
  at: number;
}

export interface CodexIndex {
  /** Every frame index that belongs to a matched lifecycle. */
  matched: Set<number>;
  /** The lifecycle to emit at this frame index. */
  emit: Map<number, Lifecycle>;
}

/**
 * Match item lifecycles locally and in order, rather than by a global set of
 * completed ids.
 *
 * `partition` changes at every attempt marker, thread and turn boundary, so a
 * reused id never reaches across one: an attempt that was killed mid-command
 * keeps its unfinished call even when the next attempt completes the same id.
 * Within a partition a lifecycle is keyed by id *and* item type -- two items
 * that merely share an id are two items -- and a start that arrives after that
 * key already completed opens a new one.
 */
export function indexCodexItems(frames: ReadonlyArray<{ frame: unknown }>): CodexIndex {
  const matched = new Set<number>();
  const emit = new Map<number, Lifecycle>();
  const open = new Map<string, Lifecycle>();
  let partition = 0;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!.frame;
    if (!isRecord(frame)) continue;
    const type = str(frame['type']);
    if (type === null) continue;
    if (type.startsWith('relayflow.attempt') || type === 'thread.started' || type.startsWith('turn.')) {
      partition += 1;
      open.clear();
      continue;
    }
    if (!ITEM_FRAMES.has(type)) continue;
    const item = isRecord(frame['item']) ? frame['item'] : null;
    if (item === null) continue;
    const id = str(item['id']);
    const itemType = str(item['type']);
    // No id is not a correlation key, and an unsupported item is not one this
    // module can merge. Either way the frame stands where it is.
    if (id === null || itemType === null || !SUPPORTED_ITEMS.has(itemType)) continue;
    const key = `${partition}\u0000${id}\u0000${itemType}`;
    let lifecycle = open.get(key);
    if (lifecycle === undefined || lifecycle.complete) {
      lifecycle = { snapshots: [], complete: false, at: index };
      open.set(key, lifecycle);
    }
    lifecycle.snapshots.push(item);
    lifecycle.complete ||= type === 'item.completed';
    emit.delete(lifecycle.at);
    lifecycle.at = index;
    emit.set(index, lifecycle);
    matched.add(index);
  }
  return { matched, emit };
}

/** Where the numbering lives; the parse loop resets it at an attempt boundary. */
export interface CodexState { seq: number }

interface Context {
  clean: (text: string) => string;
  state: CodexState;
  /** The whole source line, for a placeholder's size. */
  line: string;
  type: string;
}

function bounded(text: string, clean: (t: string) => string, limit = TARGET_MAX_CHARS): string {
  return oneLine(clean(text), limit);
}

/**
 * The textual content of an MCP result, as one string. `content` is a string
 * or the MCP content-block array; a block that carries no text (an image, say)
 * contributes nothing, exactly as `textChars` counts nothing for it.
 */
function mcpResultText(result: Record<string, unknown>): string | null {
  const content = result['content'];
  if (typeof content === 'string') return content.length === 0 ? null : content;
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue;
      const text = str(block['text']);
      if (text !== null && text.length > 0) parts.push(text);
    }
  }
  if (parts.length > 0) return parts.join('\n');
  // A result can be structured only; showing it beats reporting a size alone.
  const structured = result['structured_content'];
  return structured === undefined || structured === null ? null : JSON.stringify(structured);
}

/** A result's size, never its content. */
function textChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) if (isRecord(block)) total += str(block['text'])?.length ?? 0;
  return total;
}

/**
 * Redact the whole output, then cut it. Both bounds are applied and either one
 * sets the flag, so the reader is told the excerpt is short of the size the
 * call reported.
 */
function excerpt(output: string, clean: (text: string) => string): { text: string; truncated: boolean } {
  const cleaned = clean(output).replace(/\n+$/u, '');
  const lines = cleaned.split('\n');
  let truncated = lines.length > OUTPUT_MAX_LINES;
  let text = lines.slice(0, OUTPUT_MAX_LINES).join('\n');
  if (text.length > OUTPUT_MAX_CHARS) { text = text.slice(0, OUTPUT_MAX_CHARS); truncated = true; }
  return { text, truncated };
}

function placeholder(context: Context, itemType: string | null): TranscriptEntry {
  const label = itemType === null ? context.type : `${context.type}/${itemType}`;
  return { kind: 'unknown', type: context.clean(label), chars: context.line.length };
}

function tool(name: string, target: string, resultChars: number | null, isError: boolean,
  codex: TranscriptToolCodex): TranscriptEntry {
  return { kind: 'tool', name, target, result_chars: resultChars, is_error: isError, nested: false, codex };
}

function commandEntry(item: Record<string, unknown>, complete: boolean, context: Context,
  seq: number): TranscriptEntry | null {
  const command = item['command'];
  if (typeof command !== 'string') return null;
  const output = typeof item['aggregated_output'] === 'string' ? item['aggregated_output'] : null;
  const cut = output === null ? null : excerpt(output, context.clean);
  const exitCode = num(item['exit_code']);
  const status = str(item['status']);
  return tool('command_execution', bounded(command, context.clean), output === null ? null : output.length,
    status === 'failed' || (exitCode !== null && exitCode !== 0), {
      seq, status: status === null ? null : bounded(status, context.clean, 40),
      exit_code: exitCode, output_excerpt: cut === null ? null : cut.text,
      output_truncated: cut?.truncated === true, complete, error: null,
    });
}

/** `{"message": "..."}` is the shape both `turn.failed` and a failed call use. */
function errorText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return isRecord(value) ? str(value['message']) : null;
}

/**
 * Redact every string an argument value carries, while each one is still the
 * string the provider decoded.
 *
 * `redact` matches an environment value literally, and `JSON.stringify` escapes
 * a quote, backslash, newline or tab inside one -- so a secret containing any
 * of them no longer matches its own value once serialized, and reached the page
 * escaped but complete. Keys are provider strings too: an argument object built
 * out of an environment dump carries the value in the name.
 */
function redactLeaves(value: unknown, clean: (text: string) => string): unknown {
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return value.map((element) => redactLeaves(element, clean));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, element] of Object.entries(value)) out[clean(key)] = redactLeaves(element, clean);
  return out;
}

function mcpEntry(item: Record<string, unknown>, complete: boolean, context: Context,
  seq: number): TranscriptEntry | null {
  const server = str(item['server']);
  const name = str(item['tool']);
  if (server === null && name === null) return null;
  const args = item['arguments'];
  // Redacted twice, bounded once, and in that order. The leaves go first,
  // before serialization can escape a secret out of its own match; the
  // serialized form is redacted again by the `bounded` call below, because
  // `redact` recognises a credential field by its name and a leaf standing on
  // its own has no name left to recognise. Only then is the line cut.
  const rendered = args === undefined || args === null
    ? '' : ` ${JSON.stringify(redactLeaves(args, context.clean))}`;
  const result = isRecord(item['result']) ? item['result'] : null;
  const structured = result === null ? null : result['structured_content'];
  const failure = errorText(item['error']);
  const status = str(item['status']);
  // The result is evidence: bound and redact it exactly as command output is,
  // instead of reporting a size the reader then has to fetch with `--raw`.
  const text = result === null ? null : mcpResultText(result);
  const cut = text === null ? null : excerpt(text, context.clean);
  return tool('mcp_tool_call', bounded(`${server ?? '?'}/${name ?? '?'}${rendered}`, context.clean),
    result === null ? null : textChars(result['content']) + (structured === undefined || structured === null
      ? 0 : JSON.stringify(structured).length),
    status === 'failed' || failure !== null, {
      seq, status: status === null ? null : bounded(status, context.clean, 40),
      exit_code: null, output_excerpt: cut === null ? null : cut.text,
      output_truncated: cut?.truncated === true, complete,
      error: failure === null ? null : bounded(failure, context.clean, ERROR_MAX_CHARS),
    });
}

function fileChangeEntry(item: Record<string, unknown>, complete: boolean, context: Context): TranscriptEntry | null {
  const raw = item['changes'];
  if (!Array.isArray(raw)) return null;
  const changes: Array<{ path: string | null; change: string | null }> = [];
  let malformed = 0;
  for (const change of raw) {
    if (!isRecord(change)) { malformed += 1; continue; }
    const path = str(change['path']);
    const kind = str(change['kind']);
    if (path === null && kind === null) { malformed += 1; continue; }
    changes.push({
      path: path === null ? null : bounded(path, context.clean, PATH_MAX_CHARS),
      change: kind === null ? null : bounded(kind, context.clean, 40),
    });
  }
  const status = str(item['status']);
  return {
    kind: 'file_change', changes, malformed,
    status: status === null ? null : bounded(status, context.clean, 40), complete,
  };
}

function itemEntries(item: Record<string, unknown>, complete: boolean, context: Context): TranscriptEntry[] {
  const itemType = str(item['type']);
  if (itemType === 'agent_message') {
    const text = item['text'];
    if (typeof text !== 'string') return [placeholder(context, itemType)];
    return [{ kind: 'message', role: 'assistant', text: context.clean(text), nested: false,
      ...(complete ? {} : { complete: false }) }];
  }
  if (itemType === 'reasoning') {
    const text = item['text'];
    // The count, never the text -- the one thing Claude's renderer refuses to
    // print, and Codex is not the place that starts printing it.
    if (typeof text !== 'string') return [placeholder(context, itemType)];
    return [{ kind: 'thinking', chars: text.length, nested: false }];
  }
  if (itemType === 'error') {
    const message = errorText(item['message']);
    if (message === null) return [placeholder(context, itemType)];
    return [{ kind: 'error', source: 'item', message: bounded(message, context.clean, ERROR_MAX_CHARS) }];
  }
  if (itemType === 'command_execution' || itemType === 'mcp_tool_call') {
    // The number is only spent on a call this module could actually read, so a
    // malformed item leaves no gap in the sequence.
    const seq = context.state.seq + 1;
    const entry = itemType === 'command_execution'
      ? commandEntry(item, complete, context, seq) : mcpEntry(item, complete, context, seq);
    if (entry === null) return [placeholder(context, itemType)];
    context.state.seq = seq;
    return [entry];
  }
  if (itemType === 'file_change') {
    const entry = fileChangeEntry(item, complete, context);
    return [entry ?? placeholder(context, itemType)];
  }
  return [placeholder(context, itemType)];
}

const NO_USAGE = {
  tokens_in: null, tokens_out: null, cache_read: null, cache_creation: null, reasoning_out: null,
} as const;

/**
 * One Codex frame's entries, or undefined when the frame belongs to a
 * lifecycle that is reported at a later frame.
 */
export function codexFrame(
  frame: Record<string, unknown>, type: string, index: number, index_: CodexIndex,
  state: CodexState, clean: (text: string) => string, line: string,
): TranscriptEntry[] | undefined {
  const context: Context = { clean, state, line, type };
  if (type === 'thread.started') {
    const id = str(frame['thread_id']);
    return [{ kind: 'thread', thread_id: id === null ? null : bounded(id, clean) }];
  }
  if (type === 'turn.started') return [{ kind: 'turn', phase: 'started', ...NO_USAGE }];
  if (type === 'turn.completed') {
    const usage = isRecord(frame['usage']) ? frame['usage'] : null;
    return [{
      kind: 'turn', phase: 'completed',
      tokens_in: usage === null ? null : num(usage['input_tokens']),
      tokens_out: usage === null ? null : num(usage['output_tokens']),
      cache_read: usage === null ? null : num(usage['cached_input_tokens']),
      cache_creation: usage === null ? null : num(usage['cache_write_input_tokens']),
      reasoning_out: usage === null ? null : num(usage['reasoning_output_tokens']),
    }];
  }
  if (type === 'turn.failed' || type === 'error') {
    const message = errorText(type === 'error' ? frame['message'] : frame['error']);
    // A failure with no readable message is still a failure; it must not fall
    // through to anything that reads like success.
    const entry: TranscriptEntry = {
      kind: 'error', source: type,
      message: message === null ? '(no message)' : bounded(message, clean, ERROR_MAX_CHARS),
    };
    return type === 'turn.failed' ? [{ kind: 'turn', phase: 'failed', ...NO_USAGE }, entry] : [entry];
  }
  // Everything left in `CODEX_FRAME_TYPES` is an `item.*` frame.
  const lifecycle = index_.emit.get(index);
  if (lifecycle === undefined) {
    // Part of a lifecycle reported later, or an item this module does not
    // correlate -- no id, an unsupported type, a malformed frame.
    if (index_.matched.has(index)) return [];
    const item = isRecord(frame['item']) ? frame['item'] : null;
    if (item === null) return [placeholder(context, null)];
    return itemEntries(item, type === 'item.completed', context);
  }
  // The latest snapshot wins field by field, so a completion's null exit code
  // is not overwritten by the zero-length output its start reported.
  const merged = Object.assign({}, ...lifecycle.snapshots) as Record<string, unknown>;
  return itemEntries(merged, lifecycle.complete, context);
}

function indented(text: string): string[] {
  return text.split('\n').map((line) => `      ${safe(line)}`);
}

/** The Codex entry kinds. Undefined for everything the Claude renderer owns. */
export function renderCodexEntry(entry: TranscriptEntry): string[] | undefined {
  switch (entry.kind) {
    case 'thread':
      return [`session  codex${entry.thread_id === null ? '' : ` · thread ${safe(entry.thread_id)}`}`];
    case 'turn': {
      if (entry.phase === 'started') return [separator('turn')];
      if (entry.phase === 'failed') return [separator('turn failed')];
      const facts = [
        entry.tokens_in === null && entry.tokens_out === null ? null
          : `${entry.tokens_in === null ? '?' : thousands(entry.tokens_in)} in`
            + ` / ${entry.tokens_out === null ? '?' : thousands(entry.tokens_out)} out`,
        entry.cache_read === null ? null : `${thousands(entry.cache_read)} cache read`,
        entry.cache_creation === null ? null : `${thousands(entry.cache_creation)} cache write`,
        entry.reasoning_out === null ? null : `${thousands(entry.reasoning_out)} reasoning out`,
      ].filter((fact): fact is string => fact !== null);
      return [separator(`turn complete${facts.length === 0 ? '' : ` · ${facts.join(' · ')}`}`)];
    }
    case 'error':
      return [entry.source === 'error' ? 'error:' : `error (${safe(entry.source)}):`, ...entry.message.split('\n').map((line) => `  ${safe(line)}`)];
    case 'file_change': {
      const total = entry.changes.length + entry.malformed;
      const state = [
        entry.status === null ? null : safe(entry.status),
        entry.complete ? null : 'no completion frame',
      ].filter((fact): fact is string => fact !== null);
      const lines = [`  files  ${total} change${total === 1 ? '' : 's'}`
        + `${state.length === 0 ? '' : ` · ${state.join(' · ')}`}`];
      for (const change of entry.changes) {
        lines.push(`      ${safe(change.change ?? '?')}  ${safe(change.path ?? '(no path)')}`);
      }
      if (entry.malformed > 0) {
        lines.push(`      ${entry.malformed} change${entry.malformed === 1 ? '' : 's'}`
          + ' not rendered here — see --raw');
      }
      return lines;
    }
    case 'tool': {
      if (entry.codex === undefined) return undefined;
      const codex = entry.codex;
      // The size stays on the line whatever happened: a reviewer reading a
      // failed step needs the exit code, the status and the size together.
      const facts = [
        entry.result_chars === null ? 'no result' : `${thousands(entry.result_chars)} chars`,
        codex.exit_code === null ? null : `exit ${codex.exit_code}`,
        codex.status === null ? null : safe(codex.status),
        codex.complete ? null : 'no completion frame',
      ].filter((fact): fact is string => fact !== null);
      const lines = [`  tool ${codex.seq}  ${safe(entry.name)}  ${safe(entry.target ?? '')}  → ${facts.join(' · ')}`];
      if (codex.error !== null) lines.push(...indented(`error  ${codex.error}`));
      if (codex.output_excerpt !== null && codex.output_excerpt.length > 0) {
        lines.push(...indented(codex.output_excerpt));
      }
      if (codex.output_truncated) {
        lines.push(`      … excerpt cut at ${thousands(OUTPUT_MAX_LINES)} lines`
          + ` / ${thousands(OUTPUT_MAX_CHARS)} chars — see --raw`);
      }
      return lines;
    }
    default:
      return undefined;
  }
}
