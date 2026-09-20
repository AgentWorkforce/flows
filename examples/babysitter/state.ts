import type { Config } from './input.ts';
import { record, shaValid, text } from './input.ts';
export interface State {
  state?: unknown; merged?: unknown; draft?: unknown; headSha?: unknown; baseSha?: unknown;
  headRepo?: unknown; headRef?: unknown; author?: unknown; labels?: unknown;
  mergeable?: unknown; mergeState?: unknown; checks?: unknown; reviews?: unknown; requestedReviewers?: unknown;
}
export function eligible(s: State, c: Config): string | undefined {
  if (s.state !== 'open' || s.merged !== false || s.draft !== false) return 'PR is closed, merged, draft or missing live state';
  if (!Array.isArray(s.labels) || !s.labels.every(text)) return 'Missing or malformed labels';
  if (s.labels.some(l => c.skipLabels.includes(l.toLowerCase()))) return 'Skip label';
  if (!text(s.author) || (c.reviewAuthors.length && !c.reviewAuthors.includes(s.author.toLowerCase()))) return 'Author not allowed';
  if (!shaValid(s.headSha) || !shaValid(s.baseSha)) return 'Missing live head/base SHA';
  return undefined;
}
function latest(value: unknown): Map<string, Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = new Map<string, Record<string, unknown>>();
  for (const item of value) {
    const r = record(item);
    if (!text(r.login) || !Number.isSafeInteger(r.id) || Number(r.id) <= 0 || !['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'].includes(String(r.state)) || !shaValid(r.sha)) return undefined;
    const name = r.login.toLowerCase(), prior = result.get(name);
    if (!prior || Number(r.id) > Number(prior.id)) result.set(name, r);
  }
  return result;
}
export function ready(s: State, c: Config, head: string, edit?: { pushed: boolean }): string | undefined {
  const skip = eligible(s, c); if (skip) return skip;
  if (!shaValid(head) || s.headSha !== head) return 'Stale head';
  if (edit?.pushed) return 'Pushed a new head; wait for synchronize and new CI';
  if (s.mergeable !== true || s.mergeState !== 'clean') return 'Conflicting, pending or blocked mergeability';
  if (!Array.isArray(s.checks) || s.checks.length === 0) return 'Missing checks';
  const checks = s.checks.map(record);
  if (checks.some(r => r.sha !== head || !text(r.name) || r.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(String(r.conclusion)))) return 'Checks are missing, stale, pending or red';
  if (c.requiredChecks.some(name => !checks.some(r => String(r.name).toLowerCase() === name))) return 'Required check missing';
  const reviews = latest(s.reviews);
  if (!reviews) return 'Missing or malformed reviews';
  if ([...reviews.values()].some(r => r.state === 'CHANGES_REQUESTED')) return 'Changes requested';
  if (!Array.isArray(s.requestedReviewers) || !s.requestedReviewers.every(text)) return 'Missing requested reviewers';
  if (s.requestedReviewers.some(login => { const r = reviews.get(login.toLowerCase()); return r?.state !== 'APPROVED' || r.sha !== head; })) return 'Requested reviewer has not approved exact head';
  return undefined;
}
export function mergeAllowed(s: State, c: Config, head: string): string | undefined {
  const refusal = ready(s, c, head); if (refusal) return refusal;
  if (!c.merge || !c.organizations.includes(c.owner.toLowerCase()) || c.approvers.length === 0) return 'Merge is not authorized by configured organization and approvers';
  const approval = [...latest(s.reviews)!.entries()].some(([login, r]) => c.approvers.includes(login)
    && login !== String(s.author).toLowerCase() && login !== c.botLogin.toLowerCase()
    && !login.endsWith('[bot]') && r.state === 'APPROVED' && r.sha === head);
  if (!approval) return 'No independent authorized approval at exact head';
  return undefined;
}
