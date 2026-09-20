/** Operator configuration is separate from untrusted webhook data. */
export interface Config {
  owner: string; repo: string; number: number; headSha: string; testCommand: string;
  approvers: string[]; organizations: string[]; merge: boolean;
  reviewAuthors: string[]; skipLabels: string[]; requiredChecks: string[];
  botLogin: string; reviewerCli?: string; event?: Record<string, unknown>;
}
export const record = (x: unknown): Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};
export const shaValid = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
export const text = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const list = (x: unknown, fallback: string[] = []): string[] => {
  if (x === undefined) return fallback;
  if (!Array.isArray(x) || !x.every(text)) throw new Error('Babysitter lists must contain nonempty strings');
  return [...new Set(x.map(s => s.trim().toLowerCase()))];
};
export function parseInput(value: unknown): Config {
  const x = record(value);
  if (typeof x.owner !== 'string' || !/^[a-zA-Z0-9-]{1,39}$/.test(x.owner)
    || typeof x.repo !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(x.repo) || ['.', '..'].includes(x.repo)
    || !Number.isSafeInteger(x.number) || Number(x.number) <= 0 || !shaValid(x.headSha)
    || !text(x.testCommand) || /[\0\r\n]/.test(x.testCommand)
    || !text(x.botLogin) || (x.merge !== undefined && typeof x.merge !== 'boolean')
    || (x.reviewerCli !== undefined && !text(x.reviewerCli))) throw new Error('Invalid Babysitter configuration: pin repository, PR, full head SHA, bot identity and validation command');
  const config: Config = {
    owner: x.owner, repo: x.repo, number: Number(x.number), headSha: x.headSha,
    testCommand: x.testCommand, botLogin: x.botLogin, merge: x.merge === true,
    approvers: list(x.approvers), organizations: list(x.organizations), reviewAuthors: list(x.reviewAuthors),
    skipLabels: list(x.skipLabels, ['no-agent-relay-review']), requiredChecks: list(x.requiredChecks),
    ...(typeof x.reviewerCli === 'string' ? { reviewerCli: x.reviewerCli } : {}),
  };
  if (x.event !== undefined) {
    const event = record(x.event);
    const repository = record(event.repository);
    if (repository.full_name !== `${config.owner}/${config.repo}`) throw new Error('Event repository differs from pinned repository');
    const pr = record(event.pull_request), issue = record(event.issue), check = record(event.check_run);
    const refs = Array.isArray(check.pull_requests) ? check.pull_requests : [];
    const ref = record(refs.find(p => record(p).number === config.number));
    const number = pr.number ?? (issue.pull_request ? issue.number : undefined) ?? ref.number;
    if (number !== config.number) throw new Error('Event does not identify the pinned PR');
    const eventSha = record(pr.head).sha ?? check.head_sha;
    if (eventSha !== undefined && eventSha !== config.headSha) throw new Error('Event head differs from pinned head');
    if (event.action !== 'opened' && event.action !== 'synchronize' && event.action !== 'reopened'
      && event.action !== 'ready_for_review' && event.action !== 'submitted' && event.action !== 'completed'
      && event.action !== 'created') throw new Error('Unsupported event action');
    if ((event.action === 'submitted' && !text(record(event.review).state))
      || (event.action === 'completed' && !shaValid(check.head_sha))
      || (event.action === 'created' && (!issue.pull_request || !text(record(event.comment).body)))) throw new Error('Malformed event');
    config.event = event;
  }
  return config;
}
export const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
