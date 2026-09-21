// The authored verdict: which completions this runtime lowers, the durable
// marker that carries one, and the optional detail that says why.
//
// Split out of `authored-flow-executor.ts` so the CLI report and the status
// projection can read this vocabulary without importing the executor — and
// with it every provider adapter, MCP client and helper the executor pulls
// in. Nothing here does I/O or reads a clock.

import { AuthoredFlowExecutionError } from './authored-flow-error.js';
import { redact } from './redact.js';

/**
 * The completion reasons an authored body may declare and this executor lowers.
 *
 * `FlowCompletionReason` is wider than this on purpose — it is the journal's
 * run vocabulary plus authored verdicts — but the two sets drifting silently is
 * exactly what made a type-valid `done("step_failed")` die at runtime as
 * `unsupported_completion`. Every gate that asks "is this a completion this
 * runtime can lower?" now asks this one function, so a reason cannot be
 * accepted in one place and rejected in another.
 *
 * These are internal cross-module helpers for the authored seam (the executor,
 * the durable root, the IPC verifier, the CLI report and `flows status`), NOT
 * public SDK surface. `src/index.ts` deliberately re-exports nothing from this
 * module — keep it that way, or the whole authored seam leaks with them.
 */
export const LOWERED_COMPLETIONS = ['success', 'needs_human', 'step_failed', 'declined'] as const;
export type LoweredCompletionReason = (typeof LOWERED_COMPLETIONS)[number];

export function isLoweredCompletion(value: unknown): value is LoweredCompletionReason {
  return typeof value === 'string' && (LOWERED_COMPLETIONS as readonly string[]).includes(value);
}

/**
 * The bound on a normalized completion detail: 2,000 Unicode code points in
 * the FINAL string, {@link COMPLETION_DETAIL_TRUNCATED_SUFFIX} included.
 *
 * Code points, not `String.length`: `.length` counts UTF-16 code units, so an
 * emoji-heavy detail measured that way is half the length a reader would call
 * it. The number matches `@relayflows/surface`'s
 * `COMPLETION_DETAIL_MAX_CODE_POINTS`, which is what an author sees; it is the
 * same order as the kernel's gate-detail cap
 * (`kernel/relayflowd/src/engine/remote.rs`) but deliberately NOT the same
 * bound — that one takes 2,000 characters and then appends its suffix, so its
 * final string is longer than the number it advertises.
 */
export const COMPLETION_DETAIL_MAX_CODE_POINTS = 2000;

/** Fixed width, so the bound above can reserve exactly its room. */
export const COMPLETION_DETAIL_TRUNCATED_SUFFIX = '… (truncated)';

/**
 * Read `done()`'s optional second argument into the detail the marker carries.
 *
 * Absence has four spellings — no argument, `undefined`, `{}`, and
 * `{ detail: undefined }` — and all four mean the same thing: no detail, and a
 * marker command byte-identical to the one the one-argument call has always
 * produced. Whitespace-only joins them: say nothing, or say something.
 *
 * A `detail` that is present and not a string is a programming error the type
 * system already catches for TypeScript callers; the runtime check is here for
 * the same reason `isSurfaceFlowCompletionReason` is, and it refuses with the
 * existing closed `unsupported_completion` code rather than widening the
 * taxonomy. Refusals name the type they got, never the value — a malformed
 * detail is exactly the kind of text that may carry a credential.
 *
 * Redaction runs BEFORE truncation, and the order is load-bearing rather than
 * cosmetic: truncating first can split a token so no pattern matches it any
 * more, which is a truncation that *causes* a leak. What redaction recognises
 * is the SDK's existing policy — known token shapes, named credential fields,
 * and the values of secret-looking environment variables (`redact.ts`) — not a
 * guarantee to recognise every possible secret.
 */
export function normalizeCompletionDetail(
  options: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (options === undefined) return undefined;
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new AuthoredFlowExecutionError(
      'unsupported_completion',
      `done() options must be an object with an optional string "detail"; received ${typeName(options)}`,
    );
  }
  const detail = (options as { detail?: unknown }).detail;
  if (detail === undefined) return undefined;
  if (typeof detail !== 'string') {
    throw new AuthoredFlowExecutionError(
      'unsupported_completion',
      `done() detail must be a string; received ${typeName(detail)}`,
    );
  }
  const redacted = redact(detail, env).trim();
  return redacted.length === 0 ? undefined : bound(redacted);
}

/**
 * Is this a detail a durable record may carry?
 *
 * The gate every read boundary uses — the completed root's output, and the
 * IPC frame the Bun runner returns — so an over-long or wrong-typed value
 * fails closed there instead of flowing into a report as if it had been
 * journaled by this process.
 */
export function isDurableCompletionDetail(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && [...value].length <= COMPLETION_DETAIL_MAX_CODE_POINTS;
}

/**
 * The detail as ONE line, for a diagnostic message.
 *
 * Cloud renders a run's `error` through a line-oriented view that elides the
 * middle of a long one (`cli/cloud-read.ts` `errorLines`), so a forty-line
 * detail can lose the very finding it exists to carry. Escaping the breaks
 * keeps the whole detail on the single line that renderer cannot elide, and
 * keeps control characters out of a terminal. The unescaped normalized detail
 * still travels in the structured fields beside it.
 */
export function singleLineCompletionDetail(detail: string): string {
  return detail.replace(/[\u0000-\u001F\u007F-\u009F]/gu, (char) =>
    NAMED_ESCAPE[char] ?? `\\u${char.codePointAt(0)!.toString(16).padStart(4, '0')}`);
}

const NAMED_ESCAPE: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/**
 * The deterministic command that carries an authored verdict into the journal.
 *
 * `success` with no detail lowers to `:` because success needs no marker: the
 * marker run's own kernel `success` already IS that record. Every other
 * lowered verdict is something the kernel's completion vocabulary cannot
 * express on a step that *succeeded*, so it travels as data on stdout and is
 * read back from `step.completed`. It is deliberately not lowered as a failing
 * command: no step failed here, and a fabricated failure would put bogus
 * evidence in the journal for a flow whose steps all ran correctly.
 *
 * A detail rides in the same JSON object, so the marker stays the one durable
 * record of the verdict and the IPC verifier's existing command comparison
 * checks the detail against the journal for free. With no detail the command
 * is byte-identical to the one this function has always returned, which is
 * what keeps `spec_hash` stable for every flow that does not opt in.
 */
export function completionMarker(reason: LoweredCompletionReason, detail?: string): string {
  if (detail === undefined) {
    return reason === 'success' ? ':' : `printf '%s' '{"completionReason":"${reason}"}'`;
  }
  // `JSON.stringify` escapes quotes, backslashes and every control character,
  // so the command is one line and the only shell-significant character left
  // in it is `'` — which the single-quote escape below closes.
  const json = JSON.stringify({ completionReason: reason, detail });
  return `printf '%s' '${json.replaceAll("'", "'\\''")}'`;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function bound(text: string): string {
  const points = [...text];
  if (points.length <= COMPLETION_DETAIL_MAX_CODE_POINTS) return text;
  const keep = COMPLETION_DETAIL_MAX_CODE_POINTS - [...COMPLETION_DETAIL_TRUNCATED_SUFFIX].length;
  return `${points.slice(0, keep).join('')}${COMPLETION_DETAIL_TRUNCATED_SUFFIX}`;
}
