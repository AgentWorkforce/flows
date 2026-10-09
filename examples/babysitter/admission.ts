import type { Ctx } from '@relayflows/surface';
import { requiredReviewerModel } from './models.ts';
import { admitDelivery, type BoundPullRequest } from './binding.ts';
import { readState } from './github.ts';
import { parseInput, record, shellWord, text, type Config } from './input.ts';
import { parseOrigin, type OriginContext, type WhatChanged } from './origin.ts';
import { readSignalsAt, type Signals } from './signals.ts';
import { eligible, type State } from './state.ts';
import { bindHead, observation } from './wake.ts';
import type { Wake } from './wake.ts';

/**
 * What every standalone Babysitter body (diagnose or fix) does before its
 * agent: admit only the bound PR; refuse without origin context; reread live
 * state and require the exact server-claimed head; decline when nothing is
 * actionable. The order is the contract.
 */
const REPORT_MAX_CHARS = 12_000;
const AUTHORISED = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const DIRECTIVE = /^\s*@babysit(?:ter)?\b/i;

export interface StandalonePolicy {
  botLogin: string; label: string; reviewBots: string[]; ownAgents: string[]; agentCli?: string; agentModel?: string;
}

export function parsePolicy(value: unknown): StandalonePolicy {
  const x = record(value);
  if (!text(x.botLogin)) throw new Error('Invalid standalone Babysitter policy: botLogin is required');
  if (x.label !== undefined && !text(x.label)) throw new Error('Invalid standalone Babysitter policy: label must be nonempty');
  if (x.agentCli !== undefined && !text(x.agentCli)) throw new Error('Invalid standalone Babysitter policy: agentCli must be nonempty');
  if (x.agentModel !== undefined && !text(x.agentModel)) throw new Error('Invalid standalone Babysitter policy: agentModel must be nonempty');
  // Review bots are the only bot accounts whose feedback can wake Babysitter.
  if (x.reviewBots !== undefined && !(Array.isArray(x.reviewBots) && x.reviewBots.every(b => text(b) && b.trim().toLowerCase().endsWith('[bot]'))))
    throw new Error('Invalid standalone Babysitter policy: reviewBots must be a list of [bot] logins');
  // Our own agents' comments are never feedback (and answer the threads they reply in).
  if (x.ownAgents !== undefined && !(Array.isArray(x.ownAgents) && x.ownAgents.every(text)))
    throw new Error('Invalid standalone Babysitter policy: ownAgents must be a list of logins');
  // Resolving now refuses a custom wrapper without a model when the source loads.
  if (typeof x.agentCli === 'string') {
    try { requiredReviewerModel(x.agentCli, x.agentModel as string | undefined); }
    catch (error) { throw new Error(`Invalid standalone Babysitter policy: agentCli needs a resolvable agentModel (${(error as Error).message})`); }
  }
  return {
    botLogin: x.botLogin.trim(), label: typeof x.label === 'string' ? x.label.trim().toLowerCase() : 'babysit',
    reviewBots: [...new Set(((x.reviewBots ?? []) as string[]).map(b => b.trim().toLowerCase()))],
    ownAgents: [...new Set(((x.ownAgents ?? []) as string[]).map(a => a.trim().toLowerCase()))],
    ...(typeof x.agentCli === 'string' ? { agentCli: x.agentCli.trim() } : {}),
    ...(typeof x.agentModel === 'string' ? { agentModel: x.agentModel.trim() } : {}),
  };
}

export type StandaloneBoundPullRequest = BoundPullRequest & { headSha: string };

/** The bound PR and claimed head come from Cloud, never from the delivered webhook. */
export function boundPullRequest(value: unknown): StandaloneBoundPullRequest | undefined {
  const pr = record(record(record(value).babysitter).pullRequest);
  if (typeof pr.owner !== 'string' || typeof pr.repo !== 'string' || !Number.isSafeInteger(pr.number) || Number(pr.number) <= 0
    || typeof pr.headSha !== 'string' || !/^[a-f0-9]{40}$/.test(pr.headSha)) return undefined;
  return { owner: pr.owner, repo: pr.repo, number: Number(pr.number), headSha: pr.headSha };
}

export const reportMarker = (pr: BoundPullRequest, head: string): string =>
  `<!-- babysitter:report ${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}#${pr.number}@${head} -->`;

/** A Software Garden PR: a `relayflow/*` head in the repository itself, never a fork's look-alike. */
function gardenPullRequest(s: State, c: Config): boolean {
  return typeof s.headRef === 'string' && s.headRef.startsWith('relayflow/')
    && String(s.headRepo).toLowerCase() === `${c.owner}/${c.repo}`.toLowerCase();
}

/**
 * Why live state puts the PR out of scope, if it does: lifecycle, skip labels,
 * or neither a Software Garden PR (in scope by default, drafts included) nor
 * the opt-in label (whose drafts stay out).
 */
export function outOfScope(s: State, c: Config, label: string): string | undefined {
  // Garden drafts a PR whose checks fail; getting it out of draft is the job.
  const garden = gardenPullRequest(s, c);
  return eligible(garden ? { ...s, draft: false } : s, c)
    ?? (garden || (Array.isArray(s.labels) && s.labels.some(l => String(l).toLowerCase() === label))
      ? undefined : `Not a Software Garden PR and live labels lack the "${label}" opt-in`);
}

/**
 * What the live reread says changed; undefined when nothing is actionable.
 * `s.comments` holds only comments after Babysitter's last one, so a
 * directive it already answered cannot wake it again.
 */
export function whatChanged(s: Signals, author: string, ownAgents: string[] = []): WhatChanged | undefined {
  const directive = [...s.comments].reverse().find(m => {
    const login = m.login.toLowerCase();
    return DIRECTIVE.test(m.body) && !login.endsWith('[bot]') && !ownAgents.includes(login)
      && (login === author.toLowerCase() || AUTHORISED.includes(m.association));
  });
  if (s.failingChecks.length === 0 && s.changeRequests.length === 0 && s.reviewFeedback.length === 0 && !directive) return undefined;
  return {
    failingChecks: s.failingChecks, changeRequests: s.changeRequests, reviewFeedback: s.reviewFeedback,
    ...(directive ? { directive: { login: directive.login, body: directive.body } } : {}),
  };
}

const PROMPT_LINE_MIN_CHARS = 24;

/**
 * Agent output is untrusted: it may not publish the original prompt, ping
 * people or break out of the report. The prompt is redacted whole and line by
 * line (any line long enough to be identifying), so an agent quoting it — by
 * instruction or by injection — cannot leak it into the PR.
 */
export function neutralise(summary: string, firstPrompt: string): string {
  const redacted = '[original prompt redacted]';
  let out = summary.split(firstPrompt).join(redacted);
  for (const line of firstPrompt.split('\n').map(l => l.trim()).filter(l => l.length >= PROMPT_LINE_MIN_CHARS)) {
    out = out.split(line).join(redacted);
  }
  if (out.length > REPORT_MAX_CHARS) out = `${out.slice(0, REPORT_MAX_CHARS)}\n\n(truncated)`;
  return out.replace(/@(?=[A-Za-z0-9])/g, '@\u200b').replace(/<!--/g, '&lt;!--');
}

/** Everything the agent step needs, or the run already ended. */
export interface Admitted {
  pr: StandaloneBoundPullRequest; wake: Wake; deliveryId: string; origin: OriginContext;
  c: Config; live: State; head: string; changed: WhatChanged;
  report: (message: string) => PromiseLike<unknown>;
}

export async function admit(
  f: Ctx, value: unknown, configured: StandalonePolicy, enforced: boolean, blocked: string,
): Promise<Admitted | undefined> {
  const stop = (reason: 'declined' | 'needs_human'): undefined => { f.done(reason); return undefined; };
  const report = (message: string) => f.run(`printf '%s\\n' ${shellWord(message)}`);
  const pr = boundPullRequest(value);
  if (!pr) {
    await report('No Babysitter binding in the launch input; refusing to act on an unbound PR.');
    return stop('needs_human');
  }
  // (1) Only the bound PR. Misrouting throws before any effect.
  const { wake, deliveryId } = admitDelivery(value, pr);
  // (2) Fail closed without the original scope.
  const origin = parseOrigin(record(record(value).babysitter).originContext);
  if (!origin) {
    await report(`${wake.id} delivery=${deliveryId}: no usable origin context; Babysitter will not act without the original scope.`);
    return stop('needs_human');
  }
  // (3) A webhook is a hint: reread live state and require the exact head
  // Cloud claimed before reserving this run's per-head capacity.
  const c: Config = parseInput({ owner: pr.owner, repo: pr.repo, number: pr.number, testCommand: 'true', botLogin: configured.botLogin });
  const live: State = await readState(f, c);
  const bound = bindHead(live, c);
  await report(`${observation(c, wake, bound)} delivery=${deliveryId}`);
  if ('refusal' in bound) return stop('declined');
  const head = bound.head;
  if (head !== pr.headSha) {
    await report(`${wake.id}: live head ${head} differs from claimed head ${pr.headSha}; declining without diagnosis or comment`);
    return stop('declined');
  }
  // (4) Decline when live state leaves nothing to do.
  const skip = outOfScope(live, c, configured.label);
  if (skip) { await report(`${wake.id}: ${skip}`); return stop('declined'); }
  const signals = await readSignalsAt(f, pr, head, {
    botLogin: configured.botLogin, author: String(live.author ?? ''),
    reviewBots: configured.reviewBots, ownAgents: configured.ownAgents,
  });
  if (signals.reported) {
    await report(`${wake.id}: head ${head} already reported`); return stop('declined');
  }
  const changed = whatChanged(signals, String(live.author), configured.ownAgents);
  if (!changed) { await report(`${wake.id}: nothing actionable at ${head}`); return stop('declined'); }
  // No agent over untrusted PR content until its write scope is enforced:
  // today the agent process inherits the run's repository credentials.
  if (!enforced) {
    await report(blocked);
    return stop('needs_human');
  }
  return { pr, wake, deliveryId, origin, c, live, head, changed, report };
}
