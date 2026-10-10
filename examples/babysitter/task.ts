import { record } from './input.ts';

/**
 * A typed task from Cloud's merge train (`input.babysitter.task`). Cloud
 * writes it server-side beside the binding; a webhook cannot set it. A task
 * replaces "is there review feedback?" as the reason to act, so it is parsed
 * strictly: anything malformed stops the run before any agent.
 */
export type Task =
  | { kind: 'fix_ci'; checks: { name: string; conclusion: string; logTail: string }[] }
  | { kind: 'answer_threads'; threadIds: number[] }
  | { kind: 'resolve_conflict'; trunkSha: string };

const CHECKS_MAX = 20;
const LOG_TAIL_MAX_CHARS = 6_000;
const THREADS_MAX = 50;
const NAME_MAX_CHARS = 200;

const exactKeys = (x: Record<string, unknown>, keys: string[]) =>
  Object.keys(x).sort().join(',') === [...keys].sort().join(',');
const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/**
 * The task section appended to the fixer's agent task. Only fixed text and
 * values Cloud validated appear here; the check output itself is listed with
 * the untrusted data in "What changed".
 */
export function taskInstructions(task: Task): string {
  const head = ['', '== Merge-train task (from Cloud) =='];
  if (task.kind === 'fix_ci') return [...head,
    `The merge train holds this PR because CI is red: ${task.checks.map(c => `"${c.name}"`).join(', ')}. The log tails are listed under "What changed".`,
    '- Fix the code so these checks pass, within the original task definition. Do not weaken, skip or delete tests to make them pass.',
  ].join('\n');
  if (task.kind === 'answer_threads') return [...head,
    `The merge train holds this PR on unanswered review threads: ${task.threadIds.map(id => `#${id}`).join(', ')}.`,
    '- Address exactly those threads (fix the code or decline with a reason) and reply to each one.',
  ].join('\n');
  return [...head,
    `The merge train holds this PR because it conflicts with trunk. Trunk ${task.trunkSha} is already merged into this checkout, with the conflicts left in the files.`,
    '- Resolve every conflict so the result keeps both the PR\'s intent and trunk\'s changes. Do not commit; leave the resolution in the working tree.',
    '- Never edit `packages/web/drizzle/meta/` (`_journal.json`, snapshots): migrations are renumbered by Cloud. If a conflict needs that, stop and say so.',
    '- Change nothing outside the PR\'s own files beyond what resolving the conflicts requires.',
  ].join('\n');
}

/** `undefined` when no task was given; `'invalid'` when one was given but is malformed. */
export function parseTask(input: unknown): Task | 'invalid' | undefined {
  const babysitter = record(record(input).babysitter);
  if (!('task' in babysitter) || babysitter.task === undefined) return undefined;
  const x = babysitter.task;
  if (!plain(x)) return 'invalid';
  if (x.kind === 'fix_ci') {
    if (!exactKeys(x, ['kind', 'checks']) || !Array.isArray(x.checks) || x.checks.length === 0 || x.checks.length > CHECKS_MAX) return 'invalid';
    const checks: { name: string; conclusion: string; logTail: string }[] = [];
    for (const c of x.checks) {
      if (!plain(c) || !exactKeys(c, ['name', 'conclusion', 'logTail']) || !bounded(c.name, NAME_MAX_CHARS)
        || !bounded(c.conclusion, NAME_MAX_CHARS) || typeof c.logTail !== 'string' || c.logTail.length > LOG_TAIL_MAX_CHARS) return 'invalid';
      checks.push({ name: c.name, conclusion: c.conclusion, logTail: c.logTail });
    }
    return { kind: 'fix_ci', checks };
  }
  if (x.kind === 'answer_threads') {
    if (!exactKeys(x, ['kind', 'threadIds']) || !Array.isArray(x.threadIds) || x.threadIds.length === 0 || x.threadIds.length > THREADS_MAX) return 'invalid';
    const ids = x.threadIds;
    if (!ids.every(id => Number.isSafeInteger(id) && (id as number) > 0) || new Set(ids).size !== ids.length) return 'invalid';
    return { kind: 'answer_threads', threadIds: ids as number[] };
  }
  if (x.kind === 'resolve_conflict') {
    if (!exactKeys(x, ['kind', 'trunkSha']) || typeof x.trunkSha !== 'string' || !/^[a-f0-9]{40}$/.test(x.trunkSha)) return 'invalid';
    return { kind: 'resolve_conflict', trunkSha: x.trunkSha };
  }
  return 'invalid';
}
