import { flow, type Ctx } from '@relayflows/surface';
import { admit, neutralise, outOfScope, parsePolicy, type Admitted } from './admission.ts';
import { capabilities } from './capabilities.ts';
import { checkout, propose, REPLY_MAX_CHARS, restore, stash, SUMMARY_MAX_CHARS, type CachedSession } from './fix.ts';
import { readState } from './github.ts';
import { record } from './input.ts';
import type { Merge } from './merge.ts';
import { agentTask } from './origin.ts';
import { eligible } from './state.ts';
import { subscriptions } from './subscriptions.ts';
import { admitTask, hasTask } from './task-admission.ts';
import { taskInstructions, type Task } from './task.ts';

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

type Verdict = { reason: 'success' | 'declined' | 'needs_human'; detail?: string };
/** Either admission's result; a merge-train run also carries its task (task-admission.ts). */
type FixerAdmitted = Admitted & { task?: Task };

/**
 * For resolve_conflict, trunk is merged into the checkout before the agent
 * starts (in the checkout's own step, see fix.ts `checkout`), so the agent
 * only resolves. Why the run must stop instead, if it must: the merge was
 * refused, or drizzle metadata conflicts (not agent work).
 */
function mergeStopped(merged: Merge | undefined): string | undefined {
  if (merged === undefined) return undefined;
  if (merged.kind === 'babysitter-refusal') return merged.reason;
  return merged.metaConflicts.length
    ? `drizzle metadata conflicts with trunk (${merged.metaConflicts.join(', ')}); it needs a deterministic migration renumber, not an agent`
    : undefined;
}

/** After the agent: never propose against a moved head; otherwise one journaled proposal. */
async function afterAgent(f: Ctx, a: FixerAdmitted, dir: string, summary: string, label: string): Promise<Verdict> {
  const { pr, wake, origin, c, head, report } = a;
  // (7) Never propose against a head that no longer exists, or a PR that left
  // scope; a task run's scope is lifecycle only (task-admission.ts).
  const final = await readState(f, c);
  const left = a.task ? eligible({ ...final, draft: false }, c) : outOfScope(final, c, label);
  if (final.headSha !== head || left) {
    await report(`${wake.id}: head moved or PR left scope while fixing; no proposal for ${head}`);
    return { reason: 'declined' };
  }
  // (8) One journaled proposal. Cloud publishes it; this run never writes code to GitHub.
  const outcome = parseOutcome(summary);
  const replies = threadReplies(a, outcome.replies);
  // answer_threads exists to answer the requested threads: one left without
  // a reply would leave the merge train held while the run says success.
  if (a.task?.kind === 'answer_threads') {
    const inline = a.changed.reviewFeedback.filter(r => r.kind === 'inline');
    const replied = new Set(replies.map(r => inline.find(i => i.id === r.commentId)?.thread ?? r.commentId));
    const unanswered = [...new Set(inline.map(r => r.thread ?? r.id))].filter(t => !replied.has(t));
    if (unanswered.length) {
      await report(`${wake.id}: no reply for requested thread(s) ${unanswered.map(t => `#${t}`).join(', ')}`);
      return { reason: 'needs_human', detail: `Babysitter left requested thread(s) unanswered: ${unanswered.map(t => `#${t}`).join(', ')}` };
    }
  }
  const proposal = await propose(f, {
    dir, head, pullRequest: { owner: pr.owner, repo: pr.repo, number: pr.number },
    summary: neutralise(outcome.summary, origin.firstPrompt).slice(0, SUMMARY_MAX_CHARS),
    replies,
    ...(a.task?.kind === 'resolve_conflict' ? { mergeParent: a.task.trunkSha } : {}),
  });
  if (proposal.kind === 'babysitter-refusal') {
    await report(`${wake.id}: proposal refused: ${proposal.reason}`);
    return { reason: 'needs_human', detail: `Babysitter proposal refused: ${proposal.reason}` };
  }
  if (proposal.unpublished) {
    await report(`${wake.id}: conflict resolution not published: ${proposal.unpublished}`);
    return { reason: 'needs_human', detail: `Babysitter conflict resolution not published: ${proposal.unpublished}` };
  }
  return { reason: 'success', detail: `Babysitter proposal for ${head}: ${proposal.files.length} file(s)` };
}

export function createStandaloneFixer(policy: unknown, runtime: { enforcedAgentWriteScope: boolean } = capabilities) {
  const configured = parsePolicy(policy);
  const enforced = runtime.enforcedAgentWriteScope;
  const body = async (f: Ctx, value: unknown): Promise<void> => {
    const blocked = 'Babysitter fix blocked: the agent would inherit push-capable repository credentials; needs enforced agent write scope (gate 8 / #442).';
    // A merge-train task (task-admission.ts) replaces the review-feedback admission.
    const a: FixerAdmitted | undefined = hasTask(value)
      ? await admitTask(f, value, configured, enforced, blocked)
      : await admit(f, value, configured, enforced, blocked);
    if (!a) return;
    // (5) The bound head, checked out where the agent works. A reused sandbox
    // brings back the PR's previous checkout, with its dependencies.
    const { pr, wake, origin, head, report } = a;
    const previous = await restore(f, pr);
    let verdict: Verdict;
    let session: CachedSession | undefined;
    try {
      const work = await checkout(f, pr, head, a.task?.kind === 'resolve_conflict' ? a.task.trunkSha : undefined);
      const stopped = mergeStopped(work.merged);
      if (stopped) {
        await report(`${wake.id}: not resolving the conflict: ${stopped}`);
        verdict = { reason: 'needs_human', detail: `Babysitter conflict resolution stopped: ${stopped}` };
      } else {
        // (6) One agent carrying the original scope edits the working tree. It is
        // the origin session's own CLI, with a literal pinned model per CLI so the
        // shipped-source model audit resolves both pairs; the fixer ignores the
        // policy's agentCli override. The calls stay in this body: requirement
        // and model scans read the default body's own source.
        //
        // On a box that still holds this PR's checkout, the agent continues the
        // session the previous wake ran (`resume`), so it keeps that wake's
        // reading of the code and the original intent. A session the CLI no
        // longer has fails that step; the run then starts a fresh agent, which
        // carries the origin context in its task either way.
        const task = agentTask(origin, `${pr.owner}/${pr.repo}#${pr.number}`, head, a.changed, 'fix') + (a.task ? taskInstructions(a.task) : '');
        const resume = previous?.cli === origin.source ? previous.sessionId : undefined;
        let result;
        try {
          result = origin.source === 'codex'
            ? await f.agent('babysitter-fix', { cli: 'codex', model: 'gpt-5.6-sol', cwd: work.dir, permissions: { accessPreset: 'readwrite' }, task, resume })
            : await f.agent('babysitter-fix', { cli: 'claude', model: 'claude-sonnet-5', cwd: work.dir, permissions: { accessPreset: 'readwrite' }, task, resume });
        } catch (error) {
          if (resume === undefined) throw error;
          await report(`${wake.id}: could not resume session ${resume}; starting a fresh agent`);
          result = origin.source === 'codex'
            ? await f.agent('babysitter-fix-fresh', { cli: 'codex', model: 'gpt-5.6-sol', cwd: work.dir, permissions: { accessPreset: 'readwrite' }, task })
            : await f.agent('babysitter-fix-fresh', { cli: 'claude', model: 'claude-sonnet-5', cwd: work.dir, permissions: { accessPreset: 'readwrite' }, task });
        }
        session = result.sessionId === undefined ? undefined : { cli: origin.source, sessionId: result.sessionId };
        verdict = await afterAgent(f, a, work.dir, result.summary, configured.label);
      }
    } catch (error) {
      // Still back to the PR cache, but the run fails with its own error: once
      // a step has failed, the budget refuses the stash too (Cloud run
      // b8e5eb96), and that refusal must not replace the cause.
      await stash(f, pr, session).catch(() => undefined);
      throw error;
    }
    // Back to the PR cache, for the next wake on this box; before f.done, so
    // the stash is a step of this run.
    await stash(f, pr, session);
    f.done(verdict.reason, verdict.detail ? { detail: verdict.detail } : undefined);
  };
  return subscriptions.reduce<ReturnType<typeof flow>>(
    (handle, subscription) => handle.on(subscription.trigger, body),
    flow<unknown>('Babysitter fixer', { budget: { tokens: 1_000_000, dollars: 10, wallclock: '40m' } }, body),
  );
}
