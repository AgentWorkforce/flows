import { isAbsolute } from 'node:path';

export const MAX_REPAIR_ITERATIONS = 3;

export interface ClosePrInput {
  worktree: string;
  repo: string;
  branch: string;
  base?: string;
  title?: string;
  body?: string;
  prNumber?: number;
  cli?: string;
  model?: string;
  pollIntervalSeconds?: number;
  maxPolls?: number;
}

export function parseInput(raw: string): ClosePrInput {
  const input = JSON.parse(raw) as ClosePrInput;
  if (!input || typeof input !== 'object') throw new Error('IMPL_CLOSE_INPUT must be a JSON object');
  for (const key of ['worktree', 'repo', 'branch'] as const) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].includes('\0')) {
      throw new Error(`IMPL_CLOSE_INPUT.${key} must be a nonempty string`);
    }
  }
  if (!isAbsolute(input.worktree)) throw new Error('worktree must be an absolute path');
  if (!/^[\w.-]+\/[\w.-]+$/.test(input.repo)) throw new Error('repo must be OWNER/REPO');
  if (input.branch.startsWith('-')) throw new Error('branch must not start with -');
  for (const key of ['base', 'title', 'body', 'cli', 'model'] as const) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].includes('\0'))) {
      throw new Error(`${key} must be a string`);
    }
  }
  for (const key of ['prNumber', 'maxPolls', 'pollIntervalSeconds'] as const) {
    if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] < 1)) {
      throw new Error(`${key} must be a positive integer`);
    }
  }
  return input;
}

export function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function parsePrNumber(output: string): number {
  const match = output.trim().match(/^(?:https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/)?([1-9]\d*)\/?$/);
  const number = Number(match?.[1]);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Invalid PR number: ${output}`);
  return number;
}

export interface Check {
  name: string;
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';
  link: string;
  description: string;
}

export interface BotComment {
  id: number;
  body: string;
  path: string;
  html_url: string;
  user: { login: string };
}

export interface ReviewThread {
  isResolved: boolean;
  isOutdated: boolean;
  commentId: number;
}

export interface Finding {
  kind: 'ci' | 'bugbot';
  message: string;
  link: string;
}

/** Parse API data fail-closed: empty/malformed output must never mean green. */
export function parseChecks(raw: string): Check[] {
  const checks = JSON.parse(raw) as Check[];
  if (!Array.isArray(checks) || checks.some(check => !check || typeof check.name !== 'string'
    || !['pass', 'fail', 'pending', 'skipping', 'cancel'].includes(check.bucket)
    || typeof check.link !== 'string' || typeof check.description !== 'string')) {
    throw new Error('Invalid gh pr checks response');
  }
  return checks;
}

export function analyzeFindings(checks: Check[], commentsRaw: string, threadsRaw: string) {
  const comments = JSON.parse(commentsRaw) as BotComment[];
  const threads = JSON.parse(threadsRaw) as ReviewThread[];
  if (!Array.isArray(comments) || comments.some(comment => !comment || !Number.isSafeInteger(comment.id)
    || typeof comment.body !== 'string' || typeof comment.user?.login !== 'string'
    || typeof comment.path !== 'string' || typeof comment.html_url !== 'string')) {
    throw new Error('Invalid PR comments response');
  }
  if (!Array.isArray(threads) || threads.some(thread => !thread || !Number.isSafeInteger(thread.commentId)
    || typeof thread.isResolved !== 'boolean' || typeof thread.isOutdated !== 'boolean')) {
    throw new Error('Invalid PR review threads response');
  }
  const findings: Finding[] = checks.filter(check => ['fail', 'cancel'].includes(check.bucket))
    .map(check => ({ kind: 'ci', message: `${check.name}: ${check.bucket}. ${check.description}`, link: check.link }));
  for (const comment of comments) {
    if (!/^(cursor|bugbot)(\[bot\])?$/i.test(comment.user.login)) continue;
    const text = comment.body.replace(/<img\b[^>]*\balt=["']([^"']*)["'][^>]*>/gi, '$1')
      .replace(/<[^>]*>/g, ' ').replace(/[*_`]/g, '');
    if (!/\b(?:medium|high|critical)\s+(?:severity|priority)\b|\bseverity\s*:\s*(?:medium|high|critical)\b|\bP[012]\b/i.test(text)) continue;
    const thread = threads.find(thread => thread.commentId === comment.id);
    // Missing thread metadata is blocking. Old commit_id alone is not proof of a fix.
    if (thread?.isResolved) continue;
    findings.push({ kind: 'bugbot', message: `${comment.path}: ${comment.body}`, link: comment.html_url });
  }
  const pending = checks.length === 0 || checks.some(check => check.bucket === 'pending');
  const bugbotReviewed = checks.some(check => /bugbot/i.test(check.name) && ['pass', 'fail', 'cancel'].includes(check.bucket));
  return { findings, pending: pending || !bugbotReviewed };
}

/** gh returns 1 for failed checks and 8 for pending checks; neither is an effect failure. */
export function checksCommand(pr: number, repo: string): string {
  return `gh pr checks ${pr} --repo ${quote(repo)} --json name,bucket,link,description; `
    + 'close_status=$?; case "$close_status" in 0|1|8) exit 0 ;; *) exit "$close_status" ;; esac';
}

export function failedRunId(link: string, repo: string): string | undefined {
  let url: URL;
  try { url = new URL(link); } catch { return undefined; }
  if (url.hostname !== 'github.com') return undefined;
  const prefix = `/${repo}/actions/runs/`;
  return url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length).match(/^([0-9]+)(?:\/|$)/)?.[1] : undefined;
}
