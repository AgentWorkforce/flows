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
