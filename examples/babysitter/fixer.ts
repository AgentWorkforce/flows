import { flow, type Ctx } from '@relayflows/surface';
import { admit, neutralise, outOfScope, parsePolicy, type Admitted } from './admission.ts';
import { capabilities } from './capabilities.ts';
import { checkout, propose, REPLY_MAX_CHARS, SUMMARY_MAX_CHARS } from './fix.ts';
import { readState } from './github.ts';
import { record } from './input.ts';
import { agentTask } from './origin.ts';
import { subscriptions } from './subscriptions.ts';

/**
 * Babysitter fixer, standalone. After `admit` (admission.ts) it checks out the
 * bound head, lets one agent carrying the original scope fix what changed,
 * and journals one bounded proposal: a patch against the bound head plus
 * thread replies. It holds only the run's read and comment token; it never
 * commits, pushes, merges or reviews. Cloud publishes the proposal
 * server-side (FIXER.md): one commit whose parent is the bound head, a
 * fast-forward-only ref update, then the replies.
 */
export const replyMarker = (pr: { owner: string; repo: string; number: number }, head: string): string =>
  `<!-- babysitter:reply ${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}#${pr.number}@${head} -->`;

/** The agent's final JSON message, tolerating prose around one JSON object. */
export function parseOutcome(text: string): { summary: string; replies: { id: number; body: string }[] } {
  const candidates = [text, ...[...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(m => m[1]!).reverse()];
  for (const candidate of candidates) {
    try {
      const x = record(JSON.parse(candidate.trim()));
      if (typeof x.summary !== 'string') continue;
      const replies = (Array.isArray(x.replies) ? x.replies : []).map(record)
        .filter(r => Number.isSafeInteger(r.id) && typeof r.body === 'string' && r.body.trim())
        .map(r => ({ id: Number(r.id), body: String(r.body) }));
      return { summary: x.summary, replies };
    } catch { /* not this candidate */ }
  }
  return { summary: text, replies: [] };
}

/** Replies only to inline feedback this run was woken by, each once, bounded and neutralised. */
function threadReplies(a: Admitted, replies: { id: number; body: string }[]): { commentId: number; body: string }[] {
  const inline = new Set(a.changed.reviewFeedback.filter(r => r.kind === 'inline').map(r => r.id));
  const seen = new Set<number>();
  return replies.filter(r => inline.has(r.id) && !seen.has(r.id) && seen.add(r.id)).map(r => ({
    commentId: r.id,
    body: `${replyMarker(a.pr, a.head)}\n${neutralise(r.body, a.origin.firstPrompt).slice(0, REPLY_MAX_CHARS)}`,
  }));
}

export function createStandaloneFixer(policy: unknown, runtime: { enforcedAgentWriteScope: boolean } = capabilities) {
  const configured = parsePolicy(policy);
  const enforced = runtime.enforcedAgentWriteScope;
  const body = async (f: Ctx, value: unknown): Promise<void> => {
    const a = await admit(f, value, configured, enforced,
      'Babysitter fix blocked: the agent would inherit push-capable repository credentials; needs enforced agent write scope (gate 8 / #442).');
    if (!a) return;
    const { pr, wake, origin, c, head, report } = a;
    // (5) The bound head, checked out where the agent works.
    const work = await checkout(f, pr, head);
    // (6) One agent carrying the original scope edits the working tree. It is
    // the origin session's own CLI, with a literal pinned model per CLI so the
    // shipped-source model audit resolves both pairs; the fixer ignores the
    // policy's agentCli override.
    const task = agentTask(origin, `${pr.owner}/${pr.repo}#${pr.number}`, head, a.changed, 'fix');
    const result = origin.source === 'codex'
      ? await f.agent('babysitter-fix', { cli: 'codex', model: 'gpt-5.6-sol', cwd: work.dir, permissions: { accessPreset: 'readwrite' }, task })
      : await f.agent('babysitter-fix', { cli: 'claude', model: 'claude-sonnet-5', cwd: work.dir, permissions: { accessPreset: 'readwrite' }, task });
    // (7) Never propose against a head that no longer exists.
    const final = await readState(f, c);
    if (final.headSha !== head || outOfScope(final, c, configured.label)) {
      await report(`${wake.id}: head moved or PR left scope while fixing; no proposal for ${head}`);
      return f.done('declined');
    }
    // (8) One journaled proposal. Cloud publishes it; this run never writes code to GitHub.
    const outcome = parseOutcome(result.summary);
    const proposal = await propose(f, {
      dir: work.dir, head, pullRequest: { owner: pr.owner, repo: pr.repo, number: pr.number },
      summary: neutralise(outcome.summary, origin.firstPrompt).slice(0, SUMMARY_MAX_CHARS),
      replies: threadReplies(a, outcome.replies),
    });
    if (proposal.kind === 'babysitter-refusal') {
      await report(`${wake.id}: proposal refused: ${proposal.reason}`);
      return f.done('needs_human', { detail: `Babysitter proposal refused: ${proposal.reason}` });
    }
    f.done('success', { detail: `Babysitter proposal for ${head}: ${proposal.files.length} file(s)` });
  };
  return subscriptions.reduce<ReturnType<typeof flow>>(
    (handle, subscription) => handle.on(subscription.trigger, body),
    flow<unknown>('Babysitter fixer', { budget: { tokens: 1_000_000, dollars: 10, wallclock: '40m' } }, body),
  );
}
