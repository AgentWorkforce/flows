// Native Babysitter: an extension on Software Factory whose only effect is a
// `cloud:babysitter-turn` request for the PR a verified delivery names. The
// review itself happens in the original Codex session Cloud has bound to that
// PR; this entry holds no GitHub credentials, runs no agent, and writes nothing
// to GitHub. Hosted execution stays refused by the SDK (#549, gate 8 / #442).
import { flow, github, type Ctx, type TriggerSource } from '@relayflows/surface';
import { turnDelivery, turnReceipt, type BabysitterTurnDelivery, type Subscription } from './turn.ts';

interface TurnQueue {
  queue(request: { readonly delivery: BabysitterTurnDelivery }): PromiseLike<unknown>;
}

/**
 * The declared write, as Cloud's capability adapter spells it. The SDK `Ctx`
 * has no `capabilities` field yet; a runtime without it must fail the run,
 * never skip the turn silently. The adapter, not this entry, holds workspace,
 * activation, and the verified delivery authority.
 */
function turnQueue(f: Ctx): TurnQueue {
  const capabilities = (f as unknown as { readonly capabilities?: { readonly cloud?: { readonly babysitterTurn?: unknown } } }).capabilities;
  const port = capabilities?.cloud?.babysitterTurn;
  if (typeof port !== 'object' || port === null || typeof (port as Partial<TurnQueue>).queue !== 'function') {
    throw new Error('babysitter: this runtime does not provide the cloud:babysitter-turn write.');
  }
  return port as TurnQueue;
}

function handler(subscription: Subscription) {
  return async (f: Ctx, input: unknown): Promise<void> => {
    const delivery = turnDelivery(subscription, input);
    // A delivery-only wake: Cloud builds the prompt from the live head and the
    // trusted binding, so this entry sends no findings or prose. Refusals reject.
    turnReceipt(await turnQueue(f).queue({ delivery }));
    f.done('success');
  };
}

const handlers: readonly (readonly [TriggerSource, Subscription])[] = [
  [github.pull_request('opened'), 'pull_request.opened'],
  [github.pull_request('synchronize'), 'pull_request.synchronize'],
  [github.pull_request('reopened'), 'pull_request.reopened'],
  [github.pull_request('ready_for_review'), 'pull_request.ready_for_review'],
  [github.pull_request('closed'), 'pull_request.closed'],
  [github.pull_request('labeled'), 'pull_request.labeled'],
  [github.pull_request('unlabeled'), 'pull_request.unlabeled'],
  [github.pull_request_review({ action: 'submitted' }), 'pull_request_review.submitted'],
  [github.pull_request_review({ action: 'dismissed' }), 'pull_request_review.dismissed'],
  [github.check_run('completed'), 'check_run.completed'],
  [github.issue_comment('created'), 'issue_comment.created'],
];

// The default body is reachable only by a direct run, whose input is
// caller-controlled JSON. It never requests a turn.
export default handlers.reduce<ReturnType<typeof flow>>(
  (handle, [trigger, subscription]) => handle.on(trigger, handler(subscription)),
  flow('babysitter', { budget: { dollars: 1, wallclock: '5m' } }, async f => { f.done('declined'); }),
);
