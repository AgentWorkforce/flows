// Shared redaction for transcript files, journal digests and rendered surfaces.

const MIN_SECRET_LENGTH = 8;
const SECRET_NAME = /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE)/i;
/**
 * Relay-issued token prefixes, shared with `redactRelayError` (worker-cli.ts).
 * The tail must be at least 8 characters so journal keys such as `at_ms` are
 * not mistaken for tokens, nor agent source such as br_tag or ot_handle.
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\b(?:at|rk|nt|ot|br|arr)_(?:live_)?[A-Za-z0-9_-]{8,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bxox[abps]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
// Header forms, in prose or inside a JSON-encoded object: the header name and
// any `Bearer`/`Basic` scheme stay, the value goes. Cookies are redacted to the
// end of the line, since every pair in them is a credential.
const HEADER_VALUE = /\b(authorization|x-api-key|x-callback-token|x-nightcto-evidence-token)("?\s*[:=]\s*"?)(?!(?:Bearer\s+|Basic\s+)?\[redacted)((?:Bearer|Basic)\s+)?([^\s"',;\\]+)/gi;
const COOKIE_VALUE = /\b(cookie|set-cookie)("?\s*[:=]\s*"?)(?!\[redacted)([^\n"\\]+)/gi;
const BEARER = /\bBearer\s+(?!\[redacted)[^\s"',;\\]+/g;
const ASSIGNMENT = /\b([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)=)(?!\[redacted)[^\s"',;\\]+/gi;
const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/gm;

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
const JSON_STRING_FIELD = /("([A-Za-z0-9_.\-]{1,64})"\s*:\s*")(?!(?:Bearer\s+|Basic\s+)?\[redacted)((?:[^"\\]|\\.){4,})(")/g;
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
export type Redactor = (text: string) => string;

/**
 * One redactor for one environment: the values of secret-named variables are
 * resolved once, so a writer redacting thousands of strings does not rescan
 * `process.env` for each.
 */
export function createRedactor(env: NodeJS.ProcessEnv = process.env): Redactor {
  const byName = secretEnvValues(env);
  return (text: string): string => {
    if (text.length === 0) return text;
    // Env dumps by shape: `NAME=VALUE` where VALUE is that variable's
    // value, whatever the name. Catches `env`/`printenv` output of variables
    // whose names look harmless.
    let out = text.replace(ENV_LINE, (line, name: string, value: string) =>
      value.length >= MIN_SECRET_LENGTH && env[name] === value ? `${name}=[redacted:${name}]` : line);
    // Secret-named variables' values, wherever they appear.
    for (const [name, value] of byName) out = out.replaceAll(value, `[redacted:${name}]`);
    // Well-known token shapes and header forms; the header name stays.
    out = out.replace(PEM_BLOCK, '[redacted:private-key]');
    for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, '[redacted]');
    out = out.replace(ASSIGNMENT, '$1[redacted]');
    out = out.replace(HEADER_VALUE, (_m, name: string, sep: string, scheme: string | undefined) => `${name}${sep}${scheme ?? ''}[redacted]`);
    out = out.replace(COOKIE_VALUE, (_m, name: string, sep: string) => `${name}${sep}[redacted]`);
    out = out.replace(BEARER, 'Bearer [redacted]');
    out = out.replace(JSON_STRING_FIELD, (match, open: string, name: string, _value: string, close: string) =>
      isCredentialName(name) ? `${open}[redacted]${close}` : match);
    return out;
  };
}

/** Redact one string against the current environment. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return createRedactor(env)(text);
}

/**
 * The relay-transport error scrub `worker-cli.ts` has always applied: the two
 * relay credential names by exact match, at any length, spelled `[redacted]`.
 * Everything `redact` adds is applied after, so the historical output for
 * those two names is unchanged.
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
 * The header patterns put `\s` between the name and the value, and
 * `\s` matches newlines: `authorization:` alone at the end of a poll is a
 * complete, unredacted line, while the opaque value that lands on the next
 * poll arrives with no recognizable credential context and would print
 * verbatim. A trailing header — the colon plus only whitespace, or for
 * `authorization` one scheme word — is therefore an open context. A header
 * already followed by a non-space word has its value on that line and is not
 * open. `Bearer` is the one bare scheme word the patterns treat as a name.
 */
const OPEN_HEADER_PATTERNS: readonly RegExp[] = [
  /\bauthorization"?\s*[:=]\s*"?(?:\s+\w+)?\s*$/i,
  /\bx-callback-token"?\s*[:=]\s*"?\s*$/i,
  /\bx-nightcto-evidence-token"?\s*[:=]\s*"?\s*$/i,
  /\bx-api-key"?\s*[:=]\s*"?\s*$/i,
  /\bcookie"?\s*[:=]\s*"?\s*$/i,
  /\bset-cookie"?\s*[:=]\s*"?\s*$/i,
  /\bBearer\s*$/,
];
const PEM_OPEN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PEM_CLOSE = /-----END [A-Z ]*PRIVATE KEY-----/;

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
 * An unexported PEM block likewise needs its footer before it can be scrubbed.
 * Returns the earliest index at which such a context is open — the point past
 * which nothing may be released until more of the stream arrives — or
 * `text.length` when none is open. Holding back is line-granular upstream, so
 * a false positive delays one line one poll rather than dropping it.
 */
export function openCredentialStart(text: string): number {
  let hold = text.length;
  PEM_OPEN.lastIndex = 0;
  let pem: RegExpExecArray | null;
  while ((pem = PEM_OPEN.exec(text)) !== null) {
    if (!PEM_CLOSE.test(text.slice(pem.index + pem[0].length))) {
      hold = Math.min(hold, pem.index);
      break;
    }
  }
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
 * Does `text` end on a bare credential header — a named credential line whose
 * value, if it has one, begins on the NEXT line?
 *
 * The stream releaser needs this apart from `openCredentialStart`: that check
 * sees only a header at the very end of the consumed text, but the danger is
 * wider — a released block that *ends* on `x-callback-token:` prints the
 * header now and its value, arriving on the next line in some later poll,
 * without the context `redact` needs. `redact` folds the header's newline into
 * its own named-pattern match, so the releaser's block-prefix check cannot
 * detect the dependency on its own. Trailing whitespace-only lines after the
 * header count as part of it — the value is still to come.
 */
export function endsWithOpenCredentialHeader(text: string): boolean {
  const stripped = text.replace(/\s+$/, '');
  const lastLine = stripped.slice(stripped.lastIndexOf('\n') + 1);
  return OPEN_HEADER_PATTERNS.some((pattern) => pattern.test(lastLine));
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
