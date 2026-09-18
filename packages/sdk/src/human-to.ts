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
 */
export type HumanRecipient =
  | { readonly provider: 'slack'; readonly kind: 'channel' | 'user'; readonly target: string }
  | { readonly provider: 'github'; readonly kind: 'user'; readonly target: string }
  | { readonly provider: 'approver'; readonly kind: 'user'; readonly target: string };

const FORM = /^(slack|github)\s*:\s*(.+)$/u;

export function parseHumanRecipient(to: string): HumanRecipient {
  const trimmed = to.trim();
  const match = FORM.exec(trimmed);
  if (match === null) {
    return { provider: 'approver', kind: 'user', target: trimmed.replace(/^@/u, '') };
  }
  const provider = match[1] as 'slack' | 'github';
  const target = match[2]!.trim();
  if (provider === 'slack' && target.startsWith('#')) {
    return { provider: 'slack', kind: 'channel', target: target.slice(1) };
  }
  return { provider, kind: 'user', target: target.replace(/^@/u, '') };
}

/** The Cloud integration a recipient needs connected, if any. */
export function humanRecipientProvider(to: string): 'slack' | 'github' | undefined {
  const recipient = parseHumanRecipient(to);
  return recipient.provider === 'approver' ? undefined : recipient.provider;
}
