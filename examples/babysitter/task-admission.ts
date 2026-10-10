import type { Ctx } from '@relayflows/surface';
import { boundPullRequest, type Admitted, type StandaloneBoundPullRequest, type StandalonePolicy } from './admission.ts';
import { readState } from './github.ts';
import { parseInput, record, shellWord, type Config } from './input.ts';
import { parseOrigin, type WhatChanged } from './origin.ts';
import { readSignalsAt } from './signals.ts';
import { eligible, type State } from './state.ts';
import { parseTask, type Task } from './task.ts';
import { bindHead, observation, type Wake } from './wake.ts';

/**
 * Admission for a run Cloud's merge train launched with a typed task. The
 * order is `admit`'s (admission.ts): bound PR only, fail closed without
 * origin context, the live head must be the claimed head. The task replaces
 * "is there review feedback?" and the Garden/label scope: merge-train PRs
 * carry neither, and the server chose to act. The PR must still be open.
 * A malformed task stops the run before any live read.
 */
export type TaskAdmitted = Admitted & { task: Task };

/** True when Cloud sent a task at all, valid or not; such a run never falls back to feedback admission. */
export const hasTask = (value: unknown): boolean => parseTask(value) !== undefined;

/**
 * A merge-train run is not a GitHub delivery: Cloud launches it with
 * `event = { provider: "merge_train", eventType: "merge_train.task", deliveryId }`
 * for exactly the bound PR. Anything else is misrouted and throws, as in
 * `admitDelivery` (binding.ts).
 */
function taskDelivery(value: unknown, bound: StandaloneBoundPullRequest, task: Task): { wake: Wake; deliveryId: string } {
  const input = record(value), pr = record(input.pullRequest), event = record(input.event);
  if (event.provider !== 'merge_train' || event.eventType !== 'merge_train.task'
    || typeof pr.owner !== 'string' || pr.owner.toLowerCase() !== bound.owner.toLowerCase()
    || typeof pr.repo !== 'string' || pr.repo.toLowerCase() !== bound.repo.toLowerCase()
    || pr.number !== bound.number) {
    throw new Error('Merge-train event does not identify the bound PR');
  }
  if (typeof event.deliveryId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(event.deliveryId)) {
    throw new Error('Merge-train event must carry a valid delivery id');
  }
  return { wake: { id: 'merge_train.task', family: 'operator', action: task.kind }, deliveryId: event.deliveryId };
}

async function taskChanges(f: Ctx, pr: StandaloneBoundPullRequest, head: string, task: Task, live: State, configured: StandalonePolicy): Promise<WhatChanged | undefined> {
  if (task.kind === 'fix_ci')
    return { failingChecks: task.checks.map(c => ({ name: c.name, conclusion: c.conclusion, summary: c.logTail })), changeRequests: [], reviewFeedback: [] };
  if (task.kind === 'resolve_conflict') return { failingChecks: [], changeRequests: [], reviewFeedback: [] };
  // Only the requested threads, among review comments still unanswered on the live PR.
  const signals = await readSignalsAt(f, pr, head, {
    botLogin: configured.botLogin, author: String(live.author ?? ''), reviewBots: configured.reviewBots, ownAgents: configured.ownAgents,
  });
  const wanted = new Set(task.threadIds);
  const reviewFeedback = signals.reviewFeedback.filter(r => r.kind === 'inline' && wanted.has(r.id));
  return reviewFeedback.length ? { failingChecks: [], changeRequests: [], reviewFeedback } : undefined;
}

export async function admitTask(
  f: Ctx, value: unknown, configured: StandalonePolicy, enforced: boolean, blocked: string,
): Promise<TaskAdmitted | undefined> {
  const stop = (reason: 'declined' | 'needs_human'): undefined => { f.done(reason); return undefined; };
  const report = (message: string) => f.run(`printf '%s\\n' ${shellWord(message)}`);
  const pr = boundPullRequest(value);
  if (!pr) {
    await report('No Babysitter binding in the launch input; refusing to act on an unbound PR.');
    return stop('needs_human');
  }
  const task = parseTask(value);
  if (task === undefined || task === 'invalid') {
    await report('Malformed Babysitter task in the launch input; refusing to act.');
    return stop('needs_human');
  }
  const { wake, deliveryId } = taskDelivery(value, pr, task);
  const origin = parseOrigin(record(record(value).babysitter).originContext);
  if (!origin) {
    await report(`${wake.id} delivery=${deliveryId}: no usable origin context; Babysitter will not act without the original scope.`);
    return stop('needs_human');
  }
  const c: Config = parseInput({ owner: pr.owner, repo: pr.repo, number: pr.number, testCommand: 'true', botLogin: configured.botLogin });
  const live: State = await readState(f, c);
  const bound = bindHead(live, c);
  await report(`${observation(c, wake, bound)} delivery=${deliveryId} task=${task.kind}`);
  if ('refusal' in bound) return stop('declined');
  const head = bound.head;
  if (head !== pr.headSha) {
    await report(`${wake.id}: live head ${head} differs from claimed head ${pr.headSha}; declining`);
    return stop('declined');
  }
  const skip = eligible({ ...live, draft: false }, c);
  if (skip) { await report(`${wake.id}: ${skip}`); return stop('declined'); }
  const changed = await taskChanges(f, pr, head, task, live, configured);
  if (!changed) { await report(`${wake.id}: the requested threads are already answered at ${head}`); return stop('declined'); }
  if (!enforced) {
    await report(blocked);
    return stop('needs_human');
  }
  return { pr, wake, deliveryId, origin, c, live, head, changed, task, report };
}
