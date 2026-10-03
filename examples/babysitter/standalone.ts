import { flow, type Ctx } from '@relayflows/surface';
import { requiredReviewerModel } from './models.ts';
import { admitDelivery, type BoundPullRequest } from './binding.ts';
import { capabilities } from './capabilities.ts';
import { readState } from './github.ts';
import { parseInput, record, shellWord, text, type Config } from './input.ts';
import { agentTask, parseOrigin, type WhatChanged } from './origin.ts';
import { postReport, readSignalsAt, supersedeReport, type Signals } from './signals.ts';
import { eligible, type State } from './state.ts';
import { subscriptions } from './subscriptions.ts';
import { bindHead, observation } from './wake.ts';

/**
 * Babysitter v1, standalone: Cloud launches this body from a GitHub webhook
 * with `input.babysitter = { pullRequest, originContext }`. It needs no Relay
 * runtime. It diagnoses and comments; it never pushes, merges or reviews.
 *
 * Order is the contract: admit only the bound PR; refuse without origin
 * context; reread live state and bind its head; decline when nothing is
 * actionable; one agent with the original scope; reread and decline if the
 * head moved; one owned comment.
 */
const REPORT_MAX_CHARS = 12_000;
const AUTHORISED = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const DIRECTIVE = /^\s*@babysit(?:ter)?\b/i;

export interface StandalonePolicy { botLogin: string; label: string; agentCli?: string; agentModel?: string }

function parsePolicy(value: unknown): StandalonePolicy {
  const x = record(value);
  if (!text(x.botLogin)) throw new Error('Invalid standalone Babysitter policy: botLogin is required');
  if (x.label !== undefined && !text(x.label)) throw new Error('Invalid standalone Babysitter policy: label must be nonempty');
  if (x.agentCli !== undefined && !text(x.agentCli)) throw new Error('Invalid standalone Babysitter policy: agentCli must be nonempty');
  if (x.agentModel !== undefined && !text(x.agentModel)) throw new Error('Invalid standalone Babysitter policy: agentModel must be nonempty');
  // Resolving now refuses a custom wrapper without a model when the source loads.
  if (typeof x.agentCli === 'string') {
    try { requiredReviewerModel(x.agentCli, x.agentModel as string | undefined); }
    catch (error) { throw new Error(`Invalid standalone Babysitter policy: agentCli needs a resolvable agentModel (${(error as Error).message})`); }
  }
  return {
    botLogin: x.botLogin.trim(), label: typeof x.label === 'string' ? x.label.trim().toLowerCase() : 'babysit',
    ...(typeof x.agentCli === 'string' ? { agentCli: x.agentCli.trim() } : {}),
    ...(typeof x.agentModel === 'string' ? { agentModel: x.agentModel.trim() } : {}),
  };
}

/** The bound PR comes from Cloud's lineage, never from the delivered webhook. */
function boundPullRequest(value: unknown): BoundPullRequest | undefined {
  const pr = record(record(record(value).babysitter).pullRequest);
  if (typeof pr.owner !== 'string' || typeof pr.repo !== 'string' || !Number.isSafeInteger(pr.number) || Number(pr.number) <= 0) return undefined;
  return { owner: pr.owner, repo: pr.repo, number: Number(pr.number) };
}

export const reportMarker = (pr: BoundPullRequest, head: string): string =>
  `<!-- babysitter:report ${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}#${pr.number}@${head} -->`;

/** Why live state puts the PR out of scope, if it does: lifecycle, skip labels, or no opt-in label. */
function outOfScope(s: State, c: Config, label: string): string | undefined {
  return eligible(s, c)
    ?? (Array.isArray(s.labels) && s.labels.some(l => String(l).toLowerCase() === label) ? undefined : `Live labels lack the "${label}" opt-in`);
}

/**
 * What the live reread says changed; undefined when nothing is actionable.
 * `s.comments` holds only comments after Babysitter's last one, so a
 * directive it already answered cannot wake it again.
 */
export function whatChanged(s: Signals, author: string): WhatChanged | undefined {
  const directive = [...s.comments].reverse().find(m => {
    const login = m.login.toLowerCase();
    return DIRECTIVE.test(m.body) && !login.endsWith('[bot]')
      && (login === author.toLowerCase() || AUTHORISED.includes(m.association));
  });
  if (s.failingChecks.length === 0 && s.changeRequests.length === 0 && !directive) return undefined;
  return {
    failingChecks: s.failingChecks, changeRequests: s.changeRequests,
    ...(directive ? { directive: { login: directive.login, body: directive.body } } : {}),
  };
}

/** Agent output is untrusted: it may not ping people or break out of the report. */
function neutralise(summary: string): string {
  const bounded = summary.length > REPORT_MAX_CHARS ? `${summary.slice(0, REPORT_MAX_CHARS)}\n\n(truncated)` : summary;
  return bounded.replace(/@(?=[A-Za-z0-9])/g, '@​').replace(/<!--/g, '&lt;!--');
}

export function createStandaloneBabysitter(policy: unknown, runtime: { enforcedAgentWriteScope: boolean } = capabilities) {
  const configured = parsePolicy(policy);
  const enforced = runtime.enforcedAgentWriteScope;
  const body = async (f: Ctx, value: unknown): Promise<void> => {
    const report = (message: string) => f.run(`printf '%s\\n' ${shellWord(message)}`);
    const pr = boundPullRequest(value);
    if (!pr) {
      await report('No Babysitter binding in the launch input; refusing to act on an unbound PR.');
      return f.done('needs_human');
    }
    // (1) Only the bound PR. Misrouting throws before any effect.
    const { wake, deliveryId } = admitDelivery(value, pr);
    // (2) Fail closed without the original scope.
    const origin = parseOrigin(record(record(value).babysitter).originContext);
    if (!origin) {
      await report(`${wake.id} delivery=${deliveryId}: no usable origin context; Babysitter will not act without the original scope.`);
      return f.done('needs_human');
    }
    // (3) A webhook is a hint: reread and bind the live head.
    const c: Config = parseInput({ ...pr, testCommand: 'true', botLogin: configured.botLogin });
    const live: State = await readState(f, c);
    const bound = bindHead(live, c);
    await report(`${observation(c, wake, bound)} delivery=${deliveryId}`);
    if ('refusal' in bound) return f.done('declined');
    const head = bound.head;
    // (4) Decline when live state leaves nothing to do.
    const skip = outOfScope(live, c, configured.label);
    if (skip) { await report(`${wake.id}: ${skip}`); return f.done('declined'); }
    const signals = await readSignalsAt(f, pr, head, configured.botLogin);
    if (signals.reportedHeads.includes(head)) {
      await report(`${wake.id}: head ${head} already reported`); return f.done('declined');
    }
    const changed = whatChanged(signals, String(live.author));
    if (!changed) { await report(`${wake.id}: nothing actionable at ${head}`); return f.done('declined'); }
    // No agent over untrusted PR content until its write scope is enforced:
    // today the agent process inherits the run's repository credentials.
    if (!enforced) {
      await report('Babysitter diagnosis blocked: the agent would inherit push-capable repository credentials; needs enforced agent write scope (gate 8 / #442).');
      return f.done('needs_human');
    }
    // (5) One agent carrying the original scope.
    const cli = configured.agentCli ?? origin.source;
    const result = await f.agent('babysitter-diagnose', {
      cli, model: requiredReviewerModel(cli, configured.agentModel),
      permissions: { accessPreset: 'readonly' },
      task: agentTask(origin, `${pr.owner}/${pr.repo}#${pr.number}`, head, changed),
    });
    // (6) Never report on a head that no longer exists.
    const final = await readState(f, c);
    if (final.headSha !== head || outOfScope(final, c, configured.label)) {
      await report(`${wake.id}: head moved or PR left scope during diagnosis; not reporting on ${head}`);
      return f.done('declined');
    }
    // (7) One owned comment naming the inherited session, never its prompt.
    const id = await postReport(f, pr, [
      reportMarker(pr, head),
      `### Babysitter diagnosis for \`${head}\``,
      `Inherited the original scope of ${origin.source} session \`${origin.sessionId}\` (root \`${origin.rootSessionId}\`)`
        + `${origin.degraded.length ? `; origin context degraded: ${origin.degraded.join(', ')}` : ''}. Woken by \`${wake.id}\`.`,
      '',
      neutralise(result.summary),
      '',
      '_Diagnose-only: Babysitter made no changes to this PR._',
    ].join('\n'));
    // The comment API has no head precondition, so check after the write: a
    // report raced by a push is marked superseded rather than left standing.
    const after = await readState(f, c);
    if (after.headSha !== head) {
      await supersedeReport(f, pr, id, head, String(after.headSha));
      return f.done('declined');
    }
    f.done('success');
  };
  return subscriptions.reduce<ReturnType<typeof flow>>(
    (handle, subscription) => handle.on(subscription.trigger, body),
    flow<unknown>('Babysitter', { budget: { tokens: 400_000, dollars: 4, wallclock: '30m' } }, body),
  );
}
