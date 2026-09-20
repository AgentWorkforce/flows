import { actionsFor, subscriptionFor, type Family } from './subscriptions.ts';

/** Operator configuration is separate from untrusted webhook data. */
export interface Config {
  owner: string; repo: string; number: number; testCommand: string;
  approvers: string[]; organizations: string[]; merge: boolean;
  reviewAuthors: string[]; skipLabels: string[]; requiredChecks: string[];
  botLogin: string; reviewerCli?: string;
  /**
   * Optional operator pin. Present, it *constrains* the run to one head: the
   * run declines when live state has moved past it. Absent — the resident
   * default — every wake binds to whatever the live read says the head is.
   * It is never a source of truth, and a webhook can never set it.
   */
  headSha?: string;
  event?: Record<string, unknown>;
}
export const record = (x: unknown): Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};
export const shaValid = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
export const text = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const list = (x: unknown, fallback: string[] = []): string[] => {
  if (x === undefined) return fallback;
  if (!Array.isArray(x) || !x.every(text)) throw new Error('Babysitter lists must contain nonempty strings');
  return [...new Set(x.map(s => s.trim().toLowerCase()))];
};
/**
 * Which subscription family a payload belongs to, read from its shape rather
 * than from a header. Order is significant: a review and a check-run payload
 * both carry `pull_request` references, so the narrower shapes are tested
 * first. An unrecognised shape throws — Babysitter has no "some other event"
 * branch, because a branch it cannot name is a branch it cannot gate.
 */
export function classify(event: Record<string, unknown>): { family: Family; action: string } {
  const action = typeof event.action === 'string' ? event.action : '';
  if (record(event.check_run).head_sha !== undefined) return { family: 'check_run', action };
  if (event.review !== undefined) return { family: 'pull_request_review', action };
  if (event.comment !== undefined && event.issue !== undefined) return { family: 'issue_comment', action };
  if (event.pull_request !== undefined) return { family: 'pull_request', action };
  throw new Error('Event matches no declared Babysitter subscription family');
}

/** The head a payload claimed, when it carries one. Advisory: it never binds. */
export function hintedHead(event: Record<string, unknown>, family: Family): string | undefined {
  const value = family === 'check_run'
    ? record(event.check_run).head_sha
    : record(record(event.pull_request).head).sha;
  return shaValid(value) ? value : undefined;
}

export function parseInput(value: unknown): Config {
  const x = record(value);
  if (typeof x.owner !== 'string' || !/^[a-zA-Z0-9-]{1,39}$/.test(x.owner)
    || typeof x.repo !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(x.repo) || ['.', '..'].includes(x.repo)
    || !Number.isSafeInteger(x.number) || Number(x.number) <= 0
    || (x.headSha !== undefined && !shaValid(x.headSha))
    || !text(x.testCommand) || /[\0\r\n]/.test(x.testCommand)
    || !text(x.botLogin) || (x.merge !== undefined && typeof x.merge !== 'boolean')
    || (x.reviewerCli !== undefined && !text(x.reviewerCli))) throw new Error('Invalid Babysitter configuration: pin repository, PR, bot identity and validation command');
  const config: Config = {
    owner: x.owner, repo: x.repo, number: Number(x.number),
    testCommand: x.testCommand, botLogin: x.botLogin, merge: x.merge === true,
    approvers: list(x.approvers), organizations: list(x.organizations), reviewAuthors: list(x.reviewAuthors),
    skipLabels: list(x.skipLabels, ['no-agent-relay-review']), requiredChecks: list(x.requiredChecks),
    ...(typeof x.headSha === 'string' ? { headSha: x.headSha } : {}),
    ...(typeof x.reviewerCli === 'string' ? { reviewerCli: x.reviewerCli } : {}),
  };
  if (x.event !== undefined) config.event = parseEvent(x.event, config);
  return config;
}

/**
 * Validate a delivery as a *wake hint*.
 *
 * Two classes of check, and the difference matters. **Routing** is enforced:
 * an event naming another repository or another PR is misrouted, not stale, and
 * throwing is the only honest answer. **Content** is not: the payload's head,
 * state, labels, review verdict and check conclusion are all read later from
 * live state, so this function never rejects a delivery for disagreeing with a
 * pin. A synchronize that arrives after two more pushes is an ordinary late
 * hint — it still means "look now", and looking is exactly what the body does.
 */
function parseEvent(value: unknown, config: Config): Record<string, unknown> {
  const event = record(value);
  // GitHub owner and repository names are case-insensitive, and every other
  // comparison in this flow already lowercases them. An exact-case compare here
  // rejects every delivery for a repository the operator spelled differently.
  const delivered = record(event.repository).full_name;
  if (typeof delivered !== 'string' || delivered.toLowerCase() !== `${config.owner}/${config.repo}`.toLowerCase()) throw new Error('Event repository differs from pinned repository');
  const { family, action } = classify(event);
  if (subscriptionFor(family, action) === undefined) {
    throw new Error(`Unsubscribed ${family} action "${action}"; declared: ${actionsFor(family).join(', ')}`);
  }
  const pr = record(event.pull_request), issue = record(event.issue), check = record(event.check_run);
  if (family === 'check_run') {
    // GitHub leaves `check_run.pull_requests` empty for pull requests from
    // forks. Repository routing has already succeeded, so an unattributed check
    // is an ordinary hint: the reread decides whether its head is this PR's.
    // Refusing it here is precisely how fork CI would go unnoticed forever.
    const refs = Array.isArray(check.pull_requests) ? check.pull_requests : [];
    if (refs.length > 0 && !refs.some(p => record(p).number === config.number)) {
      throw new Error('Event does not identify the pinned PR');
    }
  } else {
    const number = family === 'issue_comment' ? (issue.pull_request ? issue.number : undefined) : pr.number;
    if (number !== config.number) throw new Error('Event does not identify the pinned PR');
  }
  if ((family === 'pull_request_review' && !text(record(event.review).state))
    || (family === 'check_run' && !shaValid(check.head_sha))
    || (family === 'pull_request' && (action === 'labeled' || action === 'unlabeled') && !text(record(event.label).name))
    || (family === 'issue_comment' && !text(record(event.comment).body))) throw new Error('Malformed event');
  return event;
}
export const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
