// Redaction for free text an agent-facing surface may print.
//
// `flows status` renders gate `detail`, transcript tails and error messages
// to a process that may be an agent, in a sandbox whose stdout is captured.
// A direct agent inherits the worker's whole environment (worker-cli.ts), so
// anything the operator exported can be echoed back into that text. This
// module is the one place that decides what never reaches the page.
//
// Applied to free text only. Identifiers — run ids, step ids, hashes and env
// NAMES — are never rewritten, so the view stays greppable.

/** Env names whose values are treated as secret when they are long enough. */
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;

/** Shorter values are flags and modes (`AUTH_MODE=off`), not material. */
const MIN_SECRET_LENGTH = 8;

/**
 * Token shapes replaced wholesale. The first is the relay token family
 * `redactRelayError` in worker-cli.ts already scrubbed; the rest are the
 * bearer, header and vendor shapes a gate render can carry.
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\b(?:at|rk|nt|ot|br|arr)_(?:live_)?[A-Za-z0-9_-]+/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bxox[abp]-[A-Za-z0-9-]+/g,
];

/**
 * Header and assignment shapes: keep the name (and an auth scheme), replace
 * the value. A value already replaced by an earlier pass is left as it is,
 * so the reader still sees which env name it came from.
 */
const NAMED_VALUE_PATTERNS: readonly RegExp[] = [
  /\b(authorization:\s*(?:\w+\s+)?)(?!\[redacted)\S+/gi,
  /\b(Bearer\s+)(?!\[redacted)\S+/g,
  /\b(x-callback-token:\s*)(?!\[redacted)\S+/gi,
  /\b(x-nightcto-evidence-token:\s*)(?!\[redacted)\S+/gi,
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)=)(?!\[redacted)\S+/gi,
];

/**
 * Credential fields in serialized JSON. A gate detail or a transcript line
 * often carries a request or config body, where the value is an opaque string
 * that matches no vendor token shape and — for anything this process did not
 * export — no environment value either: `{"authToken":"opaque-secret"}` went
 * through untouched. The field name is kept, so the reader knows what was cut.
 *
 * Quoted string values only — including escaped ones: a serialized private
 * key or nested JSON reaches these fields as `\n` and `\"`, and a value
 * class that stopped at the first backslash left every one of them intact.
 * Only where the field NAME ends in a credential noun. Containing one is not enough: `monkey` and `keyboard` are
 * ordinary fields, so the name is split on separators and camelCase humps and
 * the last word decides.
 */
const JSON_STRING_FIELD = /("([A-Za-z0-9_.\-]{1,64})"\s*:\s*")(?!\[redacted)((?:[^"\\]|\\.){4,})(")/g;
const CREDENTIAL_NOUN = /^(?:token|secret|key|password|passwd|credential|cookie)s?$/i;

function isCredentialName(name: string): boolean {
  if (name.toLowerCase() === 'authorization') return true;
  const words = name.split(/[_\-.]+/).flatMap((word) => word.split(/(?<=[a-z0-9])(?=[A-Z])/u));
  const last = words.at(-1);
  return last !== undefined && CREDENTIAL_NOUN.test(last);
}

/** Secret env values, longest first so a value that contains another is replaced whole. */
function secretEnvValues(env: NodeJS.ProcessEnv): Array<[name: string, value: string]> {
  const secrets: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) continue;
    if (SECRET_NAME.test(name)) secrets.push([name, value]);
  }
  return secrets.sort((a, b) => b[1].length - a[1].length);
}

/**
 * Scrub secret env values and known token shapes out of `text`.
 *
 * An env value is replaced by `[redacted:<NAME>]` so the reader learns which
 * variable leaked without learning its value. Token shapes are replaced by
 * `[redacted]`; header and `NAME=value` shapes keep their name.
 */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [name, value] of secretEnvValues(env)) out = out.replaceAll(value, `[redacted:${name}]`);
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, '[redacted]');
  for (const pattern of NAMED_VALUE_PATTERNS) out = out.replace(pattern, '$1[redacted]');
  out = out.replace(JSON_STRING_FIELD, (match, open: string, name: string, _value: string, close: string) =>
    isCredentialName(name) ? `${open}[redacted]${close}` : match);
  return out;
}

/**
 * The relay-transport error scrub `worker-cli.ts` has always applied: the two
 * relay credential names by exact match, at any length, spelled `[redacted]`.
 * Everything `redact` adds is applied after, so the historical output for
 * those two names and the token pattern is unchanged.
 */
export function redactRelayError(message: string, env: NodeJS.ProcessEnv = process.env): string {
  for (const key of ['RELAY_AGENT_TOKEN', 'RELAY_API_KEY']) {
    const secret = env[key];
    if (secret) message = message.replaceAll(secret, '[redacted]');
  }
  return redact(message, env);
}

/**
 * Credential heads whose value may continue past a line boundary.
 *
 * Every NAMED_VALUE pattern puts `\s` between the name and the value, and
 * `\s` matches newlines: `authorization:` alone at the end of a poll is a
 * complete, unredacted line, while the opaque value that lands on the next
 * poll arrives with no recognizable credential context and would print
 * verbatim. A trailing header — the colon plus only whitespace, or for
 * `authorization` one scheme word — is therefore an open context. A header
 * already followed by a non-space word has its value on that line and is not
 * open. `Bearer` is the one bare scheme word the patterns treat as a name.
 */
const OPEN_HEADER_PATTERNS: readonly RegExp[] = [
  /\bauthorization:(?:\s+\w+)?\s*$/i,
  /\bx-callback-token:\s*$/i,
  /\bx-nightcto-evidence-token:\s*$/i,
  /\bBearer\s*$/,
];

/** A quoted JSON field name; the value side is inspected by the scanner. */
const JSON_FIELD_HEAD = /"([A-Za-z0-9_.\-]{1,64})"/g;

/**
 * Where a named-credential context may still be half-arrived at the end of
 * `text`.
 *
 * `openSecretStart` covers secret env *values*; this covers the credential
 * *names* whose patterns can span a line break: a header released on one poll
 * leaves its late-arriving value unrecognizable on the next, and a credential
 * JSON field whose value string is not yet closed leaks its first fragment.
 * Returns the earliest index at which such a context is open — the point past
 * which nothing may be released until more of the stream arrives — or
 * `text.length` when none is open. Holding back is line-granular upstream, so
 * a false positive delays one line one poll rather than dropping it.
 */
export function openCredentialStart(text: string): number {
  let hold = text.length;
  for (const pattern of OPEN_HEADER_PATTERNS) {
    const match = pattern.exec(text);
    if (match && match.index < hold) hold = match.index;
  }
  JSON_FIELD_HEAD.lastIndex = 0;
  let head: RegExpExecArray | null;
  while ((head = JSON_FIELD_HEAD.exec(text)) !== null) {
    if (!isCredentialName(head[1]!)) continue;
    let i = head.index + head[0].length;
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (i >= text.length) { hold = Math.min(hold, head.index); continue; }
    if (text[i] !== ':') continue;
    i++;
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (i >= text.length) { hold = Math.min(hold, head.index); continue; }
    if (text.startsWith('[redacted]', i) || text[i] !== '"') continue;
    i++;
    let closed = false;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === '"') { closed = true; break; }
      i++;
    }
    if (!closed) hold = Math.min(hold, head.index);
  }
  return hold;
}

/**
 * Where a secret value may still be half-arrived at the end of `text`.
 *
 * A stream is redacted in pieces, and `redact` only replaces a secret it can
 * see whole: releasing text up to a point where a secret has begun but not
 * ended would print the first half of it and never match the second. This
 * returns the smallest index `i` for which `text.slice(i)` is a proper prefix
 * of some secret env value — the point past which nothing may be released
 * until more of the stream arrives — or `text.length` when no value is open.
 *
 * Values only, not the token and header *shapes*: those are bounded by
 * whitespace, so a reader that releases whole lines cannot cut one in half.
 */
export function openSecretStart(text: string, env: NodeJS.ProcessEnv = process.env): number {
  let start = text.length;
  for (const [, value] of secretEnvValues(env)) {
    // A proper prefix is shorter than the value, so it can only begin inside
    // the last `value.length - 1` characters; the first character narrows the
    // scan to the few positions worth comparing.
    const first = Math.max(0, text.length - value.length + 1);
    for (let at = text.indexOf(value[0]!, first); at >= 0 && at < start; at = text.indexOf(value[0]!, at + 1)) {
      if (value.startsWith(text.slice(at))) { start = at; break; }
    }
  }
  return start;
}
