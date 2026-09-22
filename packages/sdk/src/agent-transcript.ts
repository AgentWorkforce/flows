import { formatStepExcerpt } from './cli/step-excerpt.js';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ptySocketPath, type SidechannelContext } from './pty-sidechannel.js';

/**
 * Per-attempt agent transcript: the redacted, capped `stream-json` file the
 * worker writes beside the PTY socket, and the ≤ 8 KiB digest of it that rides
 * in `trajectory_tail` on every completion.
 *
 * Every bound below is enforced here and stated in what it produces — a
 * marker line at a seam, a suffix on a cut string, a boolean on the digest —
 * so a reader is told what was dropped rather than left to guess.
 */

/** Cap on one attempt's transcript file: the first 128 KiB whole, then a rolling tail. */
export const TRANSCRIPT_FILE_MAX_BYTES = 1024 * 1024;
export const TRANSCRIPT_HEAD_BYTES = 128 * 1024;
export const TRANSCRIPT_TAIL_BYTES = TRANSCRIPT_FILE_MAX_BYTES - TRANSCRIPT_HEAD_BYTES;
/** Cap on any one string leaf inside a frame (tool results, thinking, text). */
export const TRANSCRIPT_STRING_MAX_BYTES = 64 * 1024;
/**
 * Cap on the serialized digest. Half the kernel's 16 KiB `trajectory_tail`
 * boundary (relayflowd/src/server.rs), leaving room for the `relay_task`
 * sibling the worker already journals.
 */
export const TRANSCRIPT_DIGEST_MAX_BYTES = 8 * 1024;
/** Cap on an llm step's `trajectory_tail.error`; over 16 KiB the kernel refuses the completion. */
export const LLM_ERROR_MAX_BYTES = 4 * 1024;

export const FINAL_TEXT_MAX_BYTES = 2 * 1024;
export const FAILURE_EXCERPT_MAX_BYTES = 1024;
export const TOOL_INPUT_EXCERPT_MAX_CHARS = 120;
/**
 * Cap on any single provider-supplied identifier copied into `result`
 * (`model`, `session_id`, `stop_reason`, `subtype`, `claude_code_version`) and
 * on a tool name. These are attacker-influenceable strings that no reduction
 * step in `boundTranscriptDigest` trims, so they are bounded where they enter.
 */
export const DIGEST_LABEL_MAX_BYTES = 256;
/**
 * Bytes reserved inside `TRANSCRIPT_FILE_MAX_BYTES` for the
 * `relayflow.truncated` marker, so a full head plus a full tail plus the
 * marker still fits the stated per-attempt cap. The marker serializes to
 * well under this even with 20-digit counters.
 */
export const TRUNCATION_MARKER_RESERVE = 256;
export const TOOL_COUNTS_MAX = 32;
export const TOOL_LAST_CALLS_MAX = 20;
export const ARTIFACT_PATHS_MAX = 50;

/** The `system/init` keys kept; everything else on that frame is local paths and inventory. */
const INIT_KEEP = ['type', 'subtype', 'model', 'claude_code_version', 'permissionMode', 'session_id'] as const;

export interface TranscriptFile {
  path: string;
  /** Bytes the redacted transcript would have occupied without the file cap. */
  bytes_total: number;
  bytes_kept: number;
  frames_total: number;
  frames_kept: number;
  truncated: boolean;
  sha256: string;
}

export interface TranscriptToolCall {
  seq: number;
  name: string;
  input_excerpt: string;
  result_bytes?: number;
  is_error?: boolean;
}

export interface TranscriptDigest {
  attempt?: number;
  exit_code?: number | null;
  file?: TranscriptFile;
  result?: {
    provider: 'claude' | 'codex';
    model?: string;
    claude_code_version?: string;
    session_id?: string;
    subtype?: string;
    is_error?: boolean;
    stop_reason?: string;
    num_turns?: number;
    duration_ms?: number;
    duration_api_ms?: number;
    total_cost_usd?: number;
    usage?: { input?: number; output?: number; cache_read?: number; cache_creation?: number; thinking?: number };
    permission_denials?: number;
  };
  tools?: {
    counts: Array<{ name: string; calls: number; errors: number }>;
    last_calls: TranscriptToolCall[];
    total_calls: number;
    shown_calls: number;
    /** False when the provider's frames are only counted, not paired (Codex). */
    complete: boolean;
  };
  final_text?: string;
  final_text_truncated?: boolean;
  failure?: { kind: 'result' | 'tool_result' | 'stderr'; excerpt: string; truncated?: boolean };
  artifacts?: { count: number; paths: string[] };
  /**
   * Set when even the ordered reductions left the digest over its cap and it
   * was cut back to fixed-size fields — every provider-supplied string but a
   * bounded file path is gone. A reader is told rather than left guessing.
   */
  core_only?: boolean;
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `…/runs/<runId>/steps/<stepId>/attempt-<n>.transcript.jsonl`, beside the PTY socket. */
export function transcriptPath(
  context: Pick<SidechannelContext, 'dataDir' | 'runId' | 'stepId'>,
  attempt: number,
): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Invalid transcript attempt');
  return join(dirname(ptySocketPath(context)), `attempt-${attempt}.transcript.jsonl`);
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SECRET_NAME = /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE)/i;
/**
 * Relay-issued token prefixes, shared with `redactRelayError` (worker-cli.ts).
 * The tail must be at least 8 characters so journal keys such as `at_ms` are
 * not mistaken for tokens.
 */
export const RELAY_TOKEN_PATTERN = /\b(?:at|rk|nt|ot|br|arr)_(?:live_)?[A-Za-z0-9_-]{8,}/g;
const TOKEN_PATTERNS: RegExp[] = [
  RELAY_TOKEN_PATTERN,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bxox[abps]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
// Header forms, in prose or inside a JSON-encoded object: the header name and
// any `Bearer`/`Basic` scheme stay, the value goes. Cookies are redacted to the
// end of the line, since every pair in them is a credential.
const HEADER_VALUE = /\b(authorization|x-api-key|x-callback-token)("?\s*[:=]\s*"?)((?:Bearer|Basic)\s+)?(?!\[redacted)([^\s"',;\\]+)/gi;
const COOKIE_VALUE = /\b(cookie|set-cookie)("?\s*[:=]\s*"?)(?!\[redacted)([^\n"\\]+)/gi;
const BEARER = /\bBearer\s+(?!\[redacted)[A-Za-z0-9._~+/=-]{8,}/g;
const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/gm;

export type Redactor = (text: string) => string;

/**
 * One redactor for one environment: the values of secret-named variables are
 * resolved once, so a writer redacting thousands of strings does not rescan
 * `process.env` for each.
 */
export function createRedactor(env: NodeJS.ProcessEnv = process.env): Redactor {
  const byName: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.length >= 8 && SECRET_NAME.test(name)) byName.push([name, value]);
  }
  // Longest first, so a value that is a prefix of another cannot leave the
  // longer one half-redacted.
  byName.sort((a, b) => b[1].length - a[1].length);
  return (text: string): string => {
    if (text.length === 0) return text;
    // Rule 3 — env dumps by shape: `NAME=VALUE` where VALUE is that variable's
    // value, whatever the name. Catches `env`/`printenv` output of variables
    // whose names look harmless.
    let out = text.replace(ENV_LINE, (line, name: string, value: string) =>
      env[name] === value ? `${name}=[redacted:${name}]` : line);
    // Rule 2 — secret-named variables' values, wherever they appear.
    for (const [name, value] of byName) out = out.replaceAll(value, `[redacted:${name}]`);
    // Rule 4 — well-known token shapes and header forms; the header name stays.
    out = out.replace(PEM_BLOCK, '[redacted:private-key]');
    for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, '[redacted]');
    out = out.replace(HEADER_VALUE, (_m, name: string, sep: string, scheme: string | undefined) => `${name}${sep}${scheme ?? ''}[redacted]`);
    out = out.replace(COOKIE_VALUE, (_m, name: string, sep: string) => `${name}${sep}[redacted]`);
    out = out.replace(BEARER, 'Bearer [redacted]');
    return out;
  };
}

/** Redact one string against `env` (D6 rules 2–4). */
export function redactText(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return createRedactor(env)(text);
}

// ---------------------------------------------------------------------------
// Bounded strings
// ---------------------------------------------------------------------------

/** Cut `text` to at most `maxBytes` of UTF-8 on a code-point boundary. */
export function utf8Head(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

/** The last `maxBytes` of `text`, on a code-point boundary. */
export function utf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

/** Head-cut with the truncation stated in the value itself. */
export function boundedText(text: string, maxBytes: number, label = ''): { text: string; truncated: boolean } {
  const total = Buffer.byteLength(text, 'utf8');
  if (total <= maxBytes) return { text, truncated: false };
  const head = utf8Head(text, maxBytes);
  return { text: `${head}…[${label}${total - Buffer.byteLength(head, 'utf8')} bytes truncated]`, truncated: true };
}

// ---------------------------------------------------------------------------
// Frame reduction
// ---------------------------------------------------------------------------

/**
 * Redact and bound every string leaf of a parsed frame, and reduce the
 * `system/init` frame to its whitelist. Unknown frame types are kept as they
 * are, minus the same string treatment.
 */
export function reduceFrame(frame: unknown, redact: Redactor): unknown {
  if (record(frame) && frame.type === 'system' && frame.subtype === 'init') {
    const kept: RecordValue = { relayflow_reduced: true };
    for (const key of INIT_KEEP) if (frame[key] !== undefined) kept[key] = frame[key];
    if (Array.isArray(frame.tools)) kept.tools_count = frame.tools.length;
    if (Array.isArray(frame.mcp_servers)) kept.mcp_servers_count = frame.mcp_servers.length;
    return reduceValue(kept, redact);
  }
  return reduceValue(frame, redact);
}

function reduceValue(value: unknown, redact: Redactor): unknown {
  if (typeof value === 'string') return boundedText(redact(value), TRANSCRIPT_STRING_MAX_BYTES, 'relayflow: ').text;
  if (Array.isArray(value)) return value.map(item => reduceValue(item, redact));
  if (record(value)) {
    const out: RecordValue = {};
    for (const [key, item] of Object.entries(value)) out[key] = reduceValue(item, redact);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// File writer
// ---------------------------------------------------------------------------

export interface TranscriptWriter {
  /** One stdout line, without its newline. Never throws; a failed file is reported by `close`. */
  write(line: string): void;
  /** Flush the tail, finish the file, and describe it — `undefined` when the file could not be written. */
  close(): Promise<TranscriptFile | undefined>;
}

/**
 * Open the per-attempt transcript file. The first `TRANSCRIPT_HEAD_BYTES` are
 * written as they arrive, so a crash mid-run still leaves the start of the
 * transcript on disk; past that a ring of the last `TRANSCRIPT_TAIL_BYTES`
 * is kept and flushed on close, behind one `relayflow.truncated` marker line
 * that says how much fell between them.
 */
export async function openTranscriptWriter(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TranscriptWriter | undefined> {
  let handle: FileHandle;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // The agent runs as this OS user, so it can plant a symlink at the
    // transcript path; `open(path, 'w')` would follow it and truncate whatever
    // it points at. Remove whatever is there without following it, then create
    // the file exclusively so a re-planted symlink loses the race rather than
    // being followed. O_NOFOLLOW is belt to O_EXCL's braces.
    try { await unlink(path); } catch { /* absent, or not ours to remove */ }
    handle = await open(
      path,
      // eslint-disable-next-line no-bitwise
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    return undefined;
  }
  const redact = createRedactor(env);
  const hash = createHash('sha256');
  const tail: Buffer[] = [];
  let pending: Promise<void> = Promise.resolve();
  let failed = false;
  let headBytes = 0;
  let tailBytes = 0;
  let bytesTotal = 0;
  let bytesDropped = 0;
  let framesTotal = 0;
  let framesDropped = 0;
  let closed = false;

  const append = (bytes: Buffer): void => {
    hash.update(bytes);
    pending = pending.then(async () => { if (!failed) await handle.write(bytes); }).catch(() => { failed = true; });
  };

  return {
    write(line: string): void {
      if (closed || line.length === 0) return;
      let reduced: string;
      try {
        const frame: unknown = JSON.parse(line);
        reduced = JSON.stringify(reduceFrame(frame, redact));
      } catch {
        // Not a frame: kept opaque, still redacted and bounded.
        reduced = boundedText(redact(line), TRANSCRIPT_STRING_MAX_BYTES, 'relayflow: ').text;
      }
      const bytes = Buffer.from(`${reduced}\n`, 'utf8');
      framesTotal += 1;
      bytesTotal += bytes.length;
      if (tail.length === 0 && headBytes + bytes.length <= TRANSCRIPT_HEAD_BYTES) {
        headBytes += bytes.length;
        append(bytes);
        return;
      }
      tail.push(bytes);
      tailBytes += bytes.length;
      // Once anything has been dropped, `close` will write a truncation marker
      // that is part of the file too, so the tail budget shrinks by its
      // reservation — otherwise a full head plus a full tail plus the marker
      // puts the file over TRANSCRIPT_FILE_MAX_BYTES.
      const tailLimit = (): number =>
        TRANSCRIPT_TAIL_BYTES - (bytesDropped > 0 ? TRUNCATION_MARKER_RESERVE : 0);
      while (tailBytes > tailLimit() && tail.length > 0) {
        const dropped = tail.shift()!;
        tailBytes -= dropped.length;
        bytesDropped += dropped.length;
        framesDropped += 1;
      }
    },
    async close(): Promise<TranscriptFile | undefined> {
      if (closed) return undefined;
      closed = true;
      if (bytesDropped > 0) {
        append(Buffer.from(`${JSON.stringify({
          type: 'relayflow.truncated', bytes_dropped: bytesDropped, frames_dropped: framesDropped,
        })}\n`, 'utf8'));
      }
      for (const bytes of tail) append(bytes);
      await pending;
      try { await handle.close(); } catch { failed = true; }
      if (failed) return undefined;
      return {
        path,
        bytes_total: bytesTotal,
        bytes_kept: headBytes + tailBytes,
        frames_total: framesTotal,
        frames_kept: framesTotal - framesDropped,
        truncated: bytesDropped > 0,
        sha256: hash.digest('hex'),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

/**
 * Build the digest from the frames `decodeProviderResult` already parsed.
 * Claude: `tool_use` blocks are paired with `tool_result` blocks by
 * `tool_use_id`; `init` supplies model and version. Codex: `item.completed`
 * items are counted by `item.type` only, so `tools.complete` is false.
 * `failure` is filled only when the attempt did not succeed.
 */
export function buildTranscriptDigest(
  frames: RecordValue[],
  kind: 'claude' | 'codex',
  outcome: { exit_code: number | null; stderr_tail: string },
  env: NodeJS.ProcessEnv = process.env,
): Pick<TranscriptDigest, 'result' | 'tools' | 'final_text' | 'final_text_truncated' | 'failure'> {
  const redact = createRedactor(env);
  const digest: ReturnType<typeof buildTranscriptDigest> = {};
  const bounded = (text: string, max: number): { text: string; truncated: boolean } => boundedText(redact(text), max);

  if (kind === 'claude') {
    const init = frames.find(f => f.type === 'system' && f.subtype === 'init');
    const terminal = [...frames].reverse().find(f => f.type === 'result');
    const usage = record(terminal?.usage) ? terminal.usage : undefined;
    const details = record(usage?.output_tokens_details) ? usage.output_tokens_details : undefined;
    const model = label(str(init?.model) ?? frames.flatMap(f => f.type === 'assistant' && record(f.message) ? [str(f.message.model)] : []).find(Boolean));
    const version = label(str(init?.claude_code_version));
    const session = label(str(terminal?.session_id ?? init?.session_id));
    const subtype = label(str(terminal?.subtype));
    const stopReason = label(str(terminal?.stop_reason));
    digest.result = {
      provider: 'claude',
      ...(model === undefined ? {} : { model }),
      ...(version === undefined ? {} : { claude_code_version: version }),
      ...(session === undefined ? {} : { session_id: session }),
      ...(subtype === undefined ? {} : { subtype }),
      ...(typeof terminal?.is_error === 'boolean' ? { is_error: terminal.is_error } : {}),
      ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
      ...(num(terminal?.num_turns) === undefined ? {} : { num_turns: num(terminal?.num_turns) }),
      ...(num(terminal?.duration_ms) === undefined ? {} : { duration_ms: num(terminal?.duration_ms) }),
      ...(num(terminal?.duration_api_ms) === undefined ? {} : { duration_api_ms: num(terminal?.duration_api_ms) }),
      ...(num(terminal?.total_cost_usd) === undefined ? {} : { total_cost_usd: num(terminal?.total_cost_usd) }),
      ...(usage === undefined ? {} : { usage: {
        ...(num(usage.input_tokens) === undefined ? {} : { input: num(usage.input_tokens) }),
        ...(num(usage.output_tokens) === undefined ? {} : { output: num(usage.output_tokens) }),
        ...(num(usage.cache_read_input_tokens) === undefined ? {} : { cache_read: num(usage.cache_read_input_tokens) }),
        ...(num(usage.cache_creation_input_tokens) === undefined ? {} : { cache_creation: num(usage.cache_creation_input_tokens) }),
        ...(num(details?.thinking_tokens) === undefined ? {} : { thinking: num(details?.thinking_tokens) }),
      } }),
      ...(Array.isArray(terminal?.permission_denials) ? { permission_denials: terminal.permission_denials.length } : {}),
    };

    const calls: Array<TranscriptToolCall & { id?: string }> = [];
    const byId = new Map<string, TranscriptToolCall>();
    let lastToolError: string | undefined;
    for (const frame of frames) {
      const content = record(frame.message) && Array.isArray(frame.message.content) ? frame.message.content : [];
      for (const block of content) {
        if (!record(block)) continue;
        if (frame.type === 'assistant' && block.type === 'tool_use') {
          const excerpt = redact(block.input === undefined ? '' : JSON.stringify(block.input));
          const call: TranscriptToolCall & { id?: string } = {
            seq: calls.length + 1, name: label(str(block.name)) ?? '?',
            input_excerpt: excerpt.length > TOOL_INPUT_EXCERPT_MAX_CHARS ? `${excerpt.slice(0, TOOL_INPUT_EXCERPT_MAX_CHARS - 1)}…` : excerpt,
          };
          calls.push(call);
          if (typeof block.id === 'string') byId.set(block.id, call);
        } else if (frame.type === 'user' && block.type === 'tool_result') {
          const call = typeof block.tool_use_id === 'string' ? byId.get(block.tool_use_id) : undefined;
          const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
          if (call !== undefined) {
            call.result_bytes = Buffer.byteLength(text, 'utf8');
            if (block.is_error === true) call.is_error = true;
          }
          if (block.is_error === true) lastToolError = text;
        }
      }
    }
    if (calls.length > 0) {
      const counts = new Map<string, { name: string; calls: number; errors: number }>();
      for (const call of calls) {
        const entry = counts.get(call.name) ?? { name: call.name, calls: 0, errors: 0 };
        entry.calls += 1;
        if (call.is_error === true) entry.errors += 1;
        counts.set(call.name, entry);
      }
      const last = calls.slice(-TOOL_LAST_CALLS_MAX).map(({ id: _id, ...call }) => call);
      digest.tools = {
        counts: [...counts.values()].sort((a, b) => b.calls - a.calls).slice(0, TOOL_COUNTS_MAX),
        last_calls: last, total_calls: calls.length, shown_calls: last.length, complete: true,
      };
    }
    if (typeof terminal?.result === 'string') {
      const text = bounded(terminal.result, FINAL_TEXT_MAX_BYTES);
      digest.final_text = text.text;
      if (text.truncated) digest.final_text_truncated = true;
    }
    if (outcome.exit_code !== 0) {
      const failedResult = terminal !== undefined
        && (terminal.is_error === true || (typeof terminal.subtype === 'string' && terminal.subtype !== 'success'));
      if (failedResult) {
        digest.failure = failure('result', typeof terminal.result === 'string' ? terminal.result : JSON.stringify(terminal), redact);
      } else if (lastToolError !== undefined) {
        digest.failure = failure('tool_result', lastToolError, redact);
      } else if (outcome.stderr_tail.length > 0) {
        digest.failure = failure('stderr', outcome.stderr_tail, redact);
      }
    }
    return digest;
  }

  // Codex: only `turn.completed` and `item.completed{agent_message}` are
  // consumed today; tool activity is counted by item type until a fixture
  // pins the frame shapes (plan U3).
  const terminal = [...frames].reverse().find(f => f.type === 'turn.completed');
  const usage = record(terminal?.usage) ? terminal.usage : undefined;
  digest.result = {
    provider: 'codex',
    ...(usage === undefined ? {} : { usage: {
      ...(num(usage.input_tokens) === undefined ? {} : { input: num(usage.input_tokens) }),
      ...(num(usage.output_tokens) === undefined ? {} : { output: num(usage.output_tokens) }),
      ...(num(usage.cached_input_tokens) === undefined ? {} : { cache_read: num(usage.cached_input_tokens) }),
    } }),
  };
  const counts = new Map<string, { name: string; calls: number; errors: number }>();
  const texts: string[] = [];
  for (const frame of frames) {
    if (frame.type !== 'item.completed' || !record(frame.item)) continue;
    const type = label(str(frame.item.type)) ?? '?';
    if (type === 'agent_message') { if (typeof frame.item.text === 'string') texts.push(frame.item.text); continue; }
    const entry = counts.get(type) ?? { name: type, calls: 0, errors: 0 };
    entry.calls += 1;
    counts.set(type, entry);
  }
  if (counts.size > 0) {
    const total = [...counts.values()].reduce((sum, entry) => sum + entry.calls, 0);
    digest.tools = {
      counts: [...counts.values()].sort((a, b) => b.calls - a.calls).slice(0, TOOL_COUNTS_MAX),
      last_calls: [], total_calls: total, shown_calls: 0, complete: false,
    };
  }
  if (texts.length > 0) {
    const text = bounded(texts.join('\n'), FINAL_TEXT_MAX_BYTES);
    digest.final_text = text.text;
    if (text.truncated) digest.final_text_truncated = true;
  }
  if (outcome.exit_code !== 0 && outcome.stderr_tail.length > 0) {
    digest.failure = failure('stderr', outcome.stderr_tail, redact);
  }
  return digest;
}

/**
 * Provider-supplied identifiers are copied into `result` verbatim and no
 * reduction step in `boundTranscriptDigest` trims them, so an oversized one
 * (a 20 KiB `model`, say) would push the digest past the kernel's
 * `trajectory_tail` bound and fail the completion outright. Bound them here.
 */
function label(value: string | undefined): string | undefined {
  return value === undefined ? undefined : boundedText(value, DIGEST_LABEL_MAX_BYTES).text;
}

function failure(
  kind: 'result' | 'tool_result' | 'stderr',
  text: string,
  redact: Redactor,
): NonNullable<TranscriptDigest['failure']> {
  // Redact before selecting: a cut must never leave an unrecognisable secret fragment.
  const redacted = redact(text);
  const excerpt = formatStepExcerpt(redacted, FAILURE_EXCERPT_MAX_BYTES);
  return { kind, excerpt, ...(Buffer.byteLength(redacted) > FAILURE_EXCERPT_MAX_BYTES ? { truncated: true } : {}) };
}

/** Serialized size of the digest as it will be journaled. */
export function digestBytes(digest: TranscriptDigest): number {
  return Buffer.byteLength(JSON.stringify(digest), 'utf8');
}

/**
 * Shrink the digest until it serializes to at most `TRANSCRIPT_DIGEST_MAX_BYTES`,
 * in a fixed order: recent tool calls, artifact paths, final text, failure
 * excerpt, tool counts. Each cut leaves its mark — `shown_calls` under
 * `total_calls`, `artifacts.count` above `paths.length`, `final_text_truncated`,
 * `failure.truncated` — so a reader knows the digest is not the whole account.
 */
export function boundTranscriptDigest(digest: TranscriptDigest): TranscriptDigest {
  let out: TranscriptDigest = digest;
  const steps: Array<(d: TranscriptDigest) => TranscriptDigest> = [
    d => keepLastCalls(d, 10),
    d => keepArtifactPaths(d, 10),
    d => cutFinalText(d, 512),
    d => cutFailure(d, 256),
    d => keepLastCalls(d, 0),
    d => keepArtifactPaths(d, 0),
    d => d.tools === undefined ? d : { ...d, tools: { ...d.tools, counts: d.tools.counts.slice(0, 8) } },
    d => cutFinalText(d, 0),
    d => cutFailure(d, 0),
  ];
  for (const step of steps) {
    if (digestBytes(out) <= TRANSCRIPT_DIGEST_MAX_BYTES) return out;
    out = step(out);
  }
  if (digestBytes(out) <= TRANSCRIPT_DIGEST_MAX_BYTES) return out;
  // Last resort. Every step above trims a string this module produced; none of
  // them touches a provider-supplied identifier, so a pathological `model`,
  // `session_id` or set of tool names can still hold the digest over its cap —
  // and the kernel refuses the whole completion when `trajectory_tail` is
  // oversized (kernel/relayflowd/src/server.rs, step.complete). Falling back to
  // fixed-size fields keeps the attempt recorded.
  return coreDigest(out);
}

/**
 * The digest reduced to fields whose size this module controls: numbers, the
 * provider tag, a bounded path and a fixed-width hash. Nothing a provider can
 * make arbitrarily long survives, so the result is bounded by construction.
 */
function coreDigest(d: TranscriptDigest): TranscriptDigest {
  const core: TranscriptDigest = { core_only: true };
  if (d.attempt !== undefined) core.attempt = d.attempt;
  if (d.exit_code !== undefined) core.exit_code = d.exit_code;
  if (d.file !== undefined) {
    core.file = { ...d.file, path: utf8Head(d.file.path, DIGEST_LABEL_MAX_BYTES) };
  }
  if (d.result !== undefined) {
    const { provider, usage, is_error, num_turns, duration_ms, duration_api_ms, total_cost_usd, permission_denials } = d.result;
    core.result = {
      provider,
      ...(is_error === undefined ? {} : { is_error }),
      ...(num_turns === undefined ? {} : { num_turns }),
      ...(duration_ms === undefined ? {} : { duration_ms }),
      ...(duration_api_ms === undefined ? {} : { duration_api_ms }),
      ...(total_cost_usd === undefined ? {} : { total_cost_usd }),
      ...(permission_denials === undefined ? {} : { permission_denials }),
      ...(usage === undefined ? {} : { usage }),
    };
  }
  if (d.tools !== undefined) {
    core.tools = {
      counts: [], last_calls: [], total_calls: d.tools.total_calls, shown_calls: 0, complete: d.tools.complete,
    };
  }
  if (d.artifacts !== undefined) core.artifacts = { count: d.artifacts.count, paths: [] };
  if (d.final_text !== undefined || d.final_text_truncated === true) core.final_text_truncated = true;
  if (d.failure !== undefined) core.failure = { kind: d.failure.kind, excerpt: '', truncated: true };
  return core;
}

function keepLastCalls(d: TranscriptDigest, n: number): TranscriptDigest {
  if (d.tools === undefined || d.tools.last_calls.length <= n) return d;
  const last = n === 0 ? [] : d.tools.last_calls.slice(-n);
  return { ...d, tools: { ...d.tools, last_calls: last, shown_calls: last.length } };
}

function keepArtifactPaths(d: TranscriptDigest, n: number): TranscriptDigest {
  if (d.artifacts === undefined || d.artifacts.paths.length <= n) return d;
  return { ...d, artifacts: { count: d.artifacts.count, paths: d.artifacts.paths.slice(0, n) } };
}

function cutFinalText(d: TranscriptDigest, maxBytes: number): TranscriptDigest {
  if (d.final_text === undefined || Buffer.byteLength(d.final_text, 'utf8') <= maxBytes) return d;
  if (maxBytes === 0) { const { final_text: _t, ...rest } = d; return { ...rest, final_text_truncated: true }; }
  return { ...d, final_text: boundedText(d.final_text, maxBytes).text, final_text_truncated: true };
}

function cutFailure(d: TranscriptDigest, maxBytes: number): TranscriptDigest {
  if (d.failure === undefined || Buffer.byteLength(d.failure.excerpt, 'utf8') <= maxBytes) return d;
  return { ...d, failure: { ...d.failure, excerpt: boundedText(d.failure.excerpt, maxBytes).text, truncated: true } };
}
