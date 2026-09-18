/**
 * Who an `f.human(question, { to })` question is for, parsed from the
 * author's `to` string. This is the delivery contract Cloud reads (the local
 * kit records it, Cloud delivers it), so the forms are fixed here and
 * documented in docs/SURFACE.md §5 Human gates:
 *
 *   "slack:#eng"        → post in the Slack channel; anyone there may answer
 *   "slack:@khaliq"     → DM the Slack user; only they may answer
 *   "github:@khaliq"    → comment on the triggering issue / pull request,
 *                         mentioning the handle; only they may answer
 *   "khaliq"            → the deploy's approver, on whichever channel the run
 *                         was triggered from (Cloud resolves; the local kit
 *                         only records it)
 *
 * Anything else — an unknown provider (`email:x`), a provider with no target
 * (`slack:`), a GitHub channel (`github:#eng`), a target with whitespace or
 * other characters no handle carries — is refused as `human_to_invalid`
 * rather than turned into a delivery target that would silently reach no one.
 */
export type HumanRecipient =
  | { readonly provider: 'slack'; readonly kind: 'channel' | 'user'; readonly target: string }
  | { readonly provider: 'github'; readonly kind: 'user'; readonly target: string }
  | { readonly provider: 'approver'; readonly kind: 'user'; readonly target: string };

export type HumanRecipientParse =
  | { readonly ok: true; readonly recipient: HumanRecipient }
  | { readonly ok: false; readonly reason: string };

/** A Slack channel name, or a Slack / GitHub / approver handle: one word, no spaces or quotes. */
const TARGET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const PROVIDER_FORM = /^([A-Za-z][A-Za-z0-9_-]*)\s*:(.*)$/su;

export function parseHumanTo(to: string): HumanRecipientParse {
  const trimmed = to.trim();
  if (trimmed === '') return { ok: false, reason: 'to is empty' };
  const match = PROVIDER_FORM.exec(trimmed);
  if (match === null) {
    const target = trimmed.replace(/^@/u, '');
    if (!TARGET.test(target)) return { ok: false, reason: `"${trimmed}" is not a handle (one word: letters, digits, . _ -)` };
    return { ok: true, recipient: { provider: 'approver', kind: 'user', target } };
  }
  const provider = match[1]!.toLowerCase();
  const rest = match[2]!.trim();
  if (provider !== 'slack' && provider !== 'github') {
    return { ok: false, reason: `"${provider}:" is not a delivery provider; use "slack:#channel", "slack:@user", "github:@user" or a bare approver handle` };
  }
  if (rest === '') return { ok: false, reason: `"${provider}:" names no ${provider === 'slack' ? 'channel or user' : 'user'}` };
  if (rest.startsWith('#')) {
    if (provider === 'github') return { ok: false, reason: `"${trimmed}": GitHub has no channels; use "github:@user"` };
    const target = rest.slice(1);
    if (!TARGET.test(target)) return { ok: false, reason: `"${trimmed}" is not a Slack channel name` };
    return { ok: true, recipient: { provider: 'slack', kind: 'channel', target } };
  }
  const target = rest.replace(/^@/u, '');
  if (!TARGET.test(target)) return { ok: false, reason: `"${trimmed}" is not a ${provider === 'slack' ? 'Slack' : 'GitHub'} handle` };
  return { ok: true, recipient: { provider, kind: 'user', target } };
}

/** The parsed recipient of a `to` already accepted by `f.human` (`parseHumanTo` ok). */
export function parseHumanRecipient(to: string): HumanRecipient {
  const parsed = parseHumanTo(to);
  if (!parsed.ok) throw new Error(`f.human to ${parsed.reason}`);
  return parsed.recipient;
}

/** The Cloud integration a recipient needs connected: none for the approver, none for a malformed `to`. */
export function humanRecipientProvider(to: string): 'slack' | 'github' | undefined {
  const parsed = parseHumanTo(to);
  if (!parsed.ok || parsed.recipient.provider === 'approver') return undefined;
  return parsed.recipient.provider;
}
