import { flow, type Ctx } from '@relayflows/surface';
import { requiredReviewerModel } from './models.ts';
import { admit, neutralise, outOfScope, parsePolicy, reportMarker } from './admission.ts';
import { capabilities } from './capabilities.ts';
import { readState } from './github.ts';
import { agentTask } from './origin.ts';
import { annotate, postReport, settle } from './signals.ts';
import { subscriptions } from './subscriptions.ts';

export { neutralise, reportMarker, whatChanged, type StandalonePolicy } from './admission.ts';

/**
 * Babysitter v1, standalone: Cloud launches this body from a GitHub webhook
 * with `input.babysitter = { pullRequest, originContext }`. It needs no Relay
 * runtime. It diagnoses and comments; it never pushes, merges or reviews.
 *
 * After `admit` (admission.ts): one agent with the original scope; reread and
 * decline if the head moved; one owned comment.
 */
export function createStandaloneBabysitter(policy: unknown, runtime: { enforcedAgentWriteScope: boolean } = capabilities) {
  const configured = parsePolicy(policy);
  const enforced = runtime.enforcedAgentWriteScope;
  const body = async (f: Ctx, value: unknown): Promise<void> => {
    const admitted = await admit(f, value, configured, enforced,
      'Babysitter diagnosis blocked: the agent would inherit push-capable repository credentials; needs enforced agent write scope (gate 8 / #442).');
    if (!admitted) return;
    const { pr, wake, origin, c, head, changed, report } = admitted;
    // (5) One agent carrying the original scope.
    const cli = String(configured.agentCli ?? origin.source);
    const model = String(requiredReviewerModel(cli, configured.agentModel));
    const result = await f.agent('babysitter-diagnose', {
      cli, model,
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
    const marker = reportMarker(pr, head);
    const id = await postReport(f, pr, [
      marker,
      `### Babysitter diagnosis for \`${head}\``,
      `Inherited the original scope of ${origin.source} session \`${origin.sessionId}\` (root \`${origin.rootSessionId}\`)`
        + `${origin.degraded.length ? `; origin context degraded: ${origin.degraded.join(', ')}` : ''}. Woken by \`${wake.id}\`.`,
      '',
      neutralise(result.summary, origin.firstPrompt),
      '',
      '_Diagnose-only: Babysitter made no changes to this PR._',
    ].join('\n'));
    // No provider claim or precondition guards the comment, so settle after
    // the write: a concurrent run's earlier report for this head wins, and a
    // report whose head moved or whose PR left scope is marked as such.
    if (!await settle(f, pr, id, configured.botLogin, marker)) {
      await report(`${wake.id}: an earlier run already reported ${head}; removed this duplicate`);
      return f.done('declined');
    }
    const after = await readState(f, c);
    const left = after.headSha === head ? outOfScope(after, c, configured.label) : undefined;
    const stale = after.headSha !== head
      ? `**Superseded:** the head moved to \`${String(after.headSha)}\` while this was posted; this diagnosis is for \`${head}\` only.`
      : left ? `**Withdrawn:** this PR left Babysitter's scope (${left}) while this was posted.` : undefined;
    if (stale) {
      await annotate(f, pr, id, stale);
      return f.done('declined');
    }
    f.done('success');
  };
  return subscriptions.reduce<ReturnType<typeof flow>>(
    (handle, subscription) => handle.on(subscription.trigger, body),
    flow<unknown>('Babysitter', { budget: { tokens: 400_000, dollars: 4, wallclock: '30m' } }, body),
  );
}
