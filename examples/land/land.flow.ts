// land — one pinned change (repo, sha, session) reviewed, gated, fixed and,
// in shadow mode, planned as a squash commit that is never pushed. Spec:
// AgentWorkforce/cloud#5806 §5, §7, §8. Phase 0-1: shadow mode only.
//
//   flows run examples/land/land.flow.ts --input '{"repo":"owner/name","sha":"<40 hex>",
//     "sessionId":"<id>","intentFile":"/runs/<runId>/intent.md","stateDir":"/runs/<runId>"}'
//
// Run it from a fresh clone of the repository checked out at `sha` (Cloud's
// per-run sandbox). The repository names its own review and CI flows in
// land.config.json (land.config.schema.json); this flow runs them as nested
// `flows run` processes with RELAYFLOW_STATE_DIR pointing under stateDir, so
// no state is ever written inside the checkout.
//
// A  adversarial-review ∥ context-review ∥ local CI. Only context-review is
//    given intentFile; the adversarial fleet's command never names it.
// B  local CI runs alongside A; the gate needs both green (and the changelog
//    rule when it is "required").
// C  fix loop: one fix agent per round, then A + B again (the repo flows
//    rerun incrementally from their state under stateDir). Stops on the round
//    cap, a finding surviving STALL_ROUNDS rounds, a count not decreasing for
//    STALL_ROUNDS rounds, the wallclock budget, or a formatter-guard breach.
// D  fetch the base; if it moved, rebase and gate again. Conflicts escalate.
// E  the repo's CI flow with {"github":true}. Skipped in shadow mode unless
//    mergePolicy.githubGateInShadow (it pushes a throwaway ci/<sha> branch).
// F  shadow: write the would-be squash commit plan to the report. Never push.
//
// Self-contained on purpose: Cloud submits an authored .flow.ts as one source
// and refuses local imports (docs/CLOUD.md, "Current limits and scope").
import { flow, type Ctx } from '@relayflows/surface';

class NeedsHuman extends Error {}

export const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

// ---------------------------------------------------------------- land.config

export const MERGE_MODES = ['shadow', 'approval', 'auto'] as const;
export const CHANGELOG_RULES = ['required', 'optional'] as const;
export const HARNESSES = ['claude', 'codex'] as const;
export const SQUASH_AUTHORS = ['session-human', 'agent-with-human-coauthor'] as const;
export const RUNNER_OS = ['linux', 'macos'] as const;
export const RUNNER_ARCH = ['x64', 'arm64'] as const;

export interface LandConfig {
  reviewFlows: { adversarial: string; context: string };
  ciFlow: string;
  baseBranch: string;
  /** The `flows` CLI the repo's flows run under, repo-relative or on PATH. */
  flowsBin: string;
  runner: { os: (typeof RUNNER_OS)[number]; arch: (typeof RUNNER_ARCH)[number]; commands: string[]; setup: string[] };
  changelog: (typeof CHANGELOG_RULES)[number];
  mergePolicy: {
    mode: (typeof MERGE_MODES)[number];
    githubGateInShadow: boolean;
    squashAuthor: (typeof SQUASH_AUTHORS)[number];
    approvalDropAfterCleanLandings: number | null;
  };
  fixLoop: { maxRounds: number; wallclockMinutes: number; harness: (typeof HARNESSES)[number]; model?: string };
  /** Pattern for the land ref the CLI pushes; `{user}` and `{sha7}` expand. Reported only. */
  landRef: string;
}

export const LAND_CONFIG_DEFAULTS = {
  baseBranch: 'main',
  flowsBin: 'flows',
  runner: { os: 'linux', arch: 'x64', commands: ['git', 'node'], setup: [] as string[] },
  changelog: 'optional',
  mergePolicy: {
    mode: 'shadow',
    githubGateInShadow: false,
    squashAuthor: 'session-human', // PLACEHOLDER pending decision (cloud#5806 Q3)
    approvalDropAfterCleanLandings: null, // PLACEHOLDER pending decision (cloud#5806 Q6)
  },
  fixLoop: {
    maxRounds: 4, // PLACEHOLDER pending decision (cloud#5806 Q2): spec proposes 4
    wallclockMinutes: 180, // PLACEHOLDER pending decision (cloud#5806 Q2): spec proposes 3h
    harness: 'claude',
    model: undefined, // PLACEHOLDER pending decision (cloud#5806 Q2): unset = the harness's own default
  },
  landRef: 'land/{user}/{sha7}', // PLACEHOLDER pending decision (cloud#5806 Q5)
} as const satisfies Omit<LandConfig, 'reviewFlows' | 'ciFlow'>;

const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_.\/-]+$/;
const SAFE_WORD = /^[A-Za-z0-9_.:@\/-]+$/;

export function parseLandConfig(raw: unknown): LandConfig {
  const fail = (path: string, why: string): never => { throw new NeedsHuman(`land.config ${path}: ${why}`); };
  const object = (value: unknown, path: string, keys: string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
    for (const key of Object.keys(value as object)) if (!keys.includes(key)) fail(`${path}.${key}`, 'unknown key');
    return value as Record<string, unknown>;
  };
  const text = (value: unknown, path: string, pattern: RegExp): string =>
    typeof value === 'string' && pattern.test(value) ? value : fail(path, `must match ${pattern}`);
  const oneOf = <T extends string>(value: unknown, path: string, allowed: readonly T[]): T =>
    allowed.includes(value as T) ? value as T : fail(path, `must be one of ${allowed.join(', ')}`);
  const integer = (value: unknown, path: string, min: number, max: number): number =>
    Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? value as number : fail(path, `must be an integer ${min}-${max}`);
  const words = (value: unknown, path: string, pattern: RegExp): string[] =>
    Array.isArray(value) ? value.map((item, i) => text(item, `${path}[${i}]`, pattern)) : fail(path, 'must be an array');
  const D = LAND_CONFIG_DEFAULTS;

  const c = object(raw, '', ['$schema', 'reviewFlows', 'ciFlow', 'baseBranch', 'flowsBin', 'runner', 'changelog', 'mergePolicy', 'fixLoop', 'landRef']);
  const review = object(c.reviewFlows, '.reviewFlows', ['adversarial', 'context']);
  const runner = object(c.runner ?? {}, '.runner', ['os', 'arch', 'commands', 'setup']);
  const merge = object(c.mergePolicy ?? {}, '.mergePolicy', ['mode', 'githubGateInShadow', 'squashAuthor', 'approvalDropAfterCleanLandings']);
  const fix = object(c.fixLoop ?? {}, '.fixLoop', ['maxRounds', 'wallclockMinutes', 'harness', 'model']);
  const drop = merge.approvalDropAfterCleanLandings ?? D.mergePolicy.approvalDropAfterCleanLandings;
  const gateInShadow = merge.githubGateInShadow ?? D.mergePolicy.githubGateInShadow;
  return {
    reviewFlows: {
      adversarial: text(review.adversarial, '.reviewFlows.adversarial', SAFE_PATH),
      context: text(review.context, '.reviewFlows.context', SAFE_PATH),
    },
    ciFlow: text(c.ciFlow, '.ciFlow', SAFE_PATH),
    baseBranch: text(c.baseBranch ?? D.baseBranch, '.baseBranch', /^(?!-)(?!.*\.\.)[A-Za-z0-9_.\/-]+$/),
    flowsBin: text(c.flowsBin ?? D.flowsBin, '.flowsBin', SAFE_PATH),
    runner: {
      os: oneOf(runner.os ?? D.runner.os, '.runner.os', RUNNER_OS),
      arch: oneOf(runner.arch ?? D.runner.arch, '.runner.arch', RUNNER_ARCH),
      commands: words(runner.commands ?? D.runner.commands, '.runner.commands', /^[A-Za-z0-9_.+-]+$/),
      setup: words(runner.setup ?? D.runner.setup, '.runner.setup', /^[^\x00-\x1f\x7f]+$/),
    },
    changelog: oneOf(c.changelog ?? D.changelog, '.changelog', CHANGELOG_RULES),
    mergePolicy: {
      mode: oneOf(merge.mode ?? D.mergePolicy.mode, '.mergePolicy.mode', MERGE_MODES),
      githubGateInShadow: typeof gateInShadow === 'boolean' ? gateInShadow : fail('.mergePolicy.githubGateInShadow', 'must be a boolean'),
      squashAuthor: oneOf(merge.squashAuthor ?? D.mergePolicy.squashAuthor, '.mergePolicy.squashAuthor', SQUASH_AUTHORS),
      approvalDropAfterCleanLandings: drop === null ? null : integer(drop, '.mergePolicy.approvalDropAfterCleanLandings', 1, 1000),
    },
    fixLoop: {
      maxRounds: integer(fix.maxRounds ?? D.fixLoop.maxRounds, '.fixLoop.maxRounds', 1, 10),
      wallclockMinutes: integer(fix.wallclockMinutes ?? D.fixLoop.wallclockMinutes, '.fixLoop.wallclockMinutes', 10, 720),
      harness: oneOf(fix.harness ?? D.fixLoop.harness, '.fixLoop.harness', HARNESSES),
      model: fix.model === undefined ? D.fixLoop.model : text(fix.model, '.fixLoop.model', SAFE_WORD),
    },
    landRef: text(c.landRef ?? D.landRef, '.landRef', /^(?=.*\{sha7\})[A-Za-z0-9_.\/{}-]+$/),
  };
}

// ---------------------------------------------------------------------- input

export interface LandInput {
  repo: string;
  sha: string;
  baseBranch?: string;
  sessionId: string;
  /** Absolute, outside the checkout: the materialized session intent (§4). */
  intentFile: string;
  /** Absolute, outside the checkout: every byte this run writes. */
  stateDir: string;
  /** Inline config, or a repo-relative path read at the pinned sha. Default `land.config.json`. */
  config?: unknown;
  /** Linked from an escalation; defaults to the report path. */
  runUrl?: string;
}

const STATE_PATH = /^\/(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_.\/-]+$/;

export function parseInput(input: LandInput) {
  if (!input || typeof input !== 'object') throw new NeedsHuman('input must be an object');
  const check = (value: unknown, name: string, pattern: RegExp): string => {
    if (typeof value !== 'string' || !pattern.test(value)) throw new NeedsHuman(`${name} must match ${pattern}`);
    return value;
  };
  const stateDir = check(input.stateDir, 'stateDir', STATE_PATH).replace(/\/+$/, '');
  return {
    repo: check(input.repo, 'repo', /^[\w.-]+\/[\w.-]+$/),
    sha: check(input.sha, 'sha', /^[0-9a-f]{40}$/),
    baseBranch: input.baseBranch === undefined ? undefined : check(input.baseBranch, 'baseBranch', /^(?!-)(?!.*\.\.)[A-Za-z0-9_.\/-]+$/),
    sessionId: check(input.sessionId, 'sessionId', /^[A-Za-z0-9_.:-]{1,128}$/),
    intentFile: check(input.intentFile, 'intentFile', STATE_PATH),
    stateDir,
    config: input.config ?? 'land.config.json',
    runUrl: input.runUrl === undefined ? undefined : check(input.runUrl, 'runUrl', /^https:\/\/[^\s]+$/),
    runId: stateDir.split('/').pop()!,
  };
}

/** True when `path` is `dir` or below it; both absolute and normalized. */
export const isInside = (path: string, dir: string): boolean => {
  const [p, d] = [path, dir].map(x => x.replace(/\/+$/, ''));
  return p === d || p!.startsWith(`${d}/`);
};

// ------------------------------------------------------------------- findings

export interface Finding { id: string; source: string; severity: string; file: string; line?: number; title: string }

/**
 * Stable across rounds: the verifier moves lines and marks re-raised findings
 * "raised before" in the title (relay-desktop flows/lib/review.ts), so the id
 * is the file plus the normalized title. report.json carries no id field.
 */
export function findingId(source: string, file: string, title: string): string {
  const normalized = title.toLowerCase().replace(/\(?\s*raised before\s*\)?:?/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  return `${source}:${file}:${normalized}`;
}

/** Blocker/major findings from a repo review flow's report.json. */
export function blockingFindings(report: unknown, source: string): Finding[] {
  const findings = (report as { findings?: unknown })?.findings;
  if (!Array.isArray(findings)) throw new NeedsHuman(`${source} report.json has no findings array`);
  return findings
    .filter(x => x?.severity === 'blocker' || x?.severity === 'major')
    .map(x => {
      if (typeof x.file !== 'string' || typeof x.title !== 'string') throw new NeedsHuman(`${source} finding lacks file/title`);
      return { id: findingId(source, x.file, x.title), source, severity: x.severity, file: x.file, line: Number.isInteger(x.line) ? x.line : undefined, title: x.title };
    });
}

// ---------------------------------------------------------------- convergence

/** A finding surviving, or the count not falling, this many fix rounds stops the loop. */
export const STALL_ROUNDS = 2;

export type Decision =
  | { action: 'proceed' }
  | { action: 'fix' }
  | { action: 'escalate'; reason: 'budget' | 'round_cap' | 'stuck_finding' | 'not_decreasing'; detail: string };

/** `history` is every gate's blocking finding ids, oldest first; the last is current. */
export function decideConvergence(s: { history: string[][]; roundsDone: number; maxRounds: number; elapsedMs: number; budgetMs: number }): Decision {
  const current = s.history.at(-1);
  if (!current) throw new Error('decideConvergence needs at least one gate result');
  if (current.length === 0) return { action: 'proceed' };
  if (s.elapsedMs >= s.budgetMs) return { action: 'escalate', reason: 'budget', detail: `wallclock budget ${Math.round(s.budgetMs / 60_000)}m spent` };
  if (s.roundsDone >= s.maxRounds) return { action: 'escalate', reason: 'round_cap', detail: `${s.roundsDone} of ${s.maxRounds} fix rounds used` };
  const window = s.history.slice(-(STALL_ROUNDS + 1));
  if (window.length === STALL_ROUNDS + 1) {
    const stuck = current.filter(id => window.every(gate => gate.includes(id)));
    if (stuck.length) return { action: 'escalate', reason: 'stuck_finding', detail: `survived ${STALL_ROUNDS} rounds: ${stuck.join('; ')}` };
    if (window.every((gate, i) => i === 0 || gate.length >= window[i - 1]!.length)) {
      return { action: 'escalate', reason: 'not_decreasing', detail: `finding count ${window.map(g => g.length).join(' -> ')}` };
    }
  }
  return { action: 'fix' };
}

// ----------------------------------------------------------------- escalation

export const ESCALATION_MAX_BYTES = 150;
const bytes = (value: string): number => Buffer.byteLength(value, 'utf8');

/**
 * `Land <repo>@<sha7> stuck: <n> blockers after <r> rounds. Fix or abort? <runUrl>`,
 * at most 150 UTF-8 bytes. Over the limit the summary shrinks: first the repo
 * owner is dropped, then the name is cut with an ellipsis. The sha, the ask and
 * the URL are never cut; a URL too long to fit even then is refused.
 */
export function escalationMessage(p: { repo: string; sha: string; blockers: number; rounds: number; runUrl: string }): string {
  const tail = `@${p.sha.slice(0, 7)} stuck: ${p.blockers} blockers after ${p.rounds} rounds. Fix or abort? ${p.runUrl}`;
  const name = p.repo.split('/').pop()!;
  for (const repo of [p.repo, name]) if (bytes(`Land ${repo}${tail}`) <= ESCALATION_MAX_BYTES) return `Land ${repo}${tail}`;
  const room = ESCALATION_MAX_BYTES - bytes(`Land …${tail}`);
  if (room < 0) throw new Error(`runUrl too long for a ${ESCALATION_MAX_BYTES}-byte escalation`);
  let cut = '';
  for (const ch of name) { if (bytes(cut + ch) > room) break; cut += ch; }
  return `Land ${cut}…${tail}`;
}

// ------------------------------------------------------------ formatter guard

/** A fix round may touch only change files and files its findings name (§6). */
export function formatterGuard(p: { roundFiles: string[]; changeFiles: string[]; findingFiles: string[] }): { ok: boolean; outside: string[]; detail: string } {
  const allowed = new Set([...p.changeFiles, ...p.findingFiles]);
  const outside = [...new Set(p.roundFiles)].filter(file => !allowed.has(file)).sort();
  if (!outside.length) return { ok: true, outside, detail: '' };
  const rustOnly = outside.every(file => file.endsWith('.rs'));
  return {
    ok: false, outside,
    detail: `fix round touched ${outside.length} file(s) outside change ∪ findings${rustOnly && outside.length > 1 ? ' (looks like crate-wide cargo fmt churn)' : ''}: ${outside.slice(0, 10).join(', ')}`,
  };
}

// ------------------------------------------------------------------ changelog

/** The lines of the `## Unreleased` section, heading excluded. */
export function unreleasedSection(changelog: string): string[] {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex(line => /^## Unreleased\s*$/i.test(line));
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** `changelog: required`: the change adds at least one bullet under `## Unreleased`. */
export function unreleasedBulletAdded(before: string, after: string): boolean {
  const old = new Set(unreleasedSection(before).map(line => line.trim()));
  return unreleasedSection(after).some(line => /^\s*[-*] \S/.test(line) && !old.has(line.trim()));
}

// ---------------------------------------------------------------- squash plan

export interface SquashPlan { base: string; baseSha: string; headSha: string; tree: string; author: string; coAuthors: string[]; message: string; pushed: false }

export function squashPlan(p: { base: string; baseSha: string; headSha: string; tree: string; subjects: string[]; sessionId: string; runId: string; squashAuthor: LandConfig['mergePolicy']['squashAuthor']; fixRounds: number; harness: string }): SquashPlan {
  const [subject = `Land ${p.headSha.slice(0, 7)}`, ...rest] = p.subjects;
  const body = rest.map(s => `- ${s}`).join('\n');
  const message = [subject, body, `Relay-Session: ${p.sessionId}\nLand-Run: ${p.runId}`].filter(Boolean).join('\n\n');
  return {
    base: p.base, baseSha: p.baseSha, headSha: p.headSha, tree: p.tree,
    // Identities come from Cloud's session resolution; this flow only records the rule.
    author: `<${p.squashAuthor}: resolved by Cloud> (PLACEHOLDER pending decision (cloud#5806 Q3))`,
    coAuthors: ['<session agent>', ...(p.fixRounds ? [`<fix agent: ${p.harness}>`] : [])],
    message, pushed: false,
  };
}

// ---------------------------------------------------------------------- steps

const POLL_SECONDS = 780; // under f.run's 15-minute lease
const LOCAL = 'git -c user.name=relay-land -c user.email=relay-land@localhost'; // sandbox-only commits; never pushed

const now = async (f: Ctx): Promise<number> => {
  const raw = (await f.run('node -p Date.now()', { timeout: '5s' })).trim();
  if (!/^\d+$/.test(raw)) throw new Error('invalid journaled clock');
  return Number(raw);
};

const writeFile = (path: string, content: string): string =>
  `printf %s ${shellWord(Buffer.from(content, 'utf8').toString('base64'))} | base64 -d > ${shellWord(path)}`;

/** Run a long command detached and poll it in lease-sized steps (repo flows take up to 45m; GitHub CI ~150m). */
export async function background(f: Ctx, dir: string, command: string, minutes: number): Promise<{ exitCode: number; tail: string }> {
  const exit = `${dir}/exit`;
  await f.run(`mkdir -p ${shellWord(dir)} && rm -f ${shellWord(exit)} && ` +
    `{ nohup sh -c ${shellWord(`${command}; echo $? > ${exit}.tmp && mv ${exit}.tmp ${exit}`)} > ${shellWord(`${dir}/log`)} 2>&1 < /dev/null & } && echo started`);
  for (let poll = 0; poll * POLL_SECONDS < minutes * 60; poll++) {
    const out = (await f.run(`for i in $(seq 1 ${POLL_SECONDS}); do if [ -f ${shellWord(exit)} ]; then cat ${shellWord(exit)}; exit 0; fi; sleep 1; done; echo pending`, { timeout: '14m' })).trim();
    if (out !== 'pending') {
      const tail = await f.run(`tail -c 1500 ${shellWord(`${dir}/log`)}`);
      return { exitCode: Number(out), tail };
    }
  }
  throw new NeedsHuman(`${command.split(' --input')[0]} did not finish within ${minutes}m; log at ${dir}/log`);
}

interface Run {
  input: ReturnType<typeof parseInput>;
  config: LandConfig;
  base: string;
  root: string;
  flowsState: string;
}

/** The nested `flows run` for a repo flow. Its journal and its state both live under stateDir. */
export const repoFlowCommand = (r: Run, name: string, path: string, input: unknown): string =>
  `RELAYFLOW_STATE_DIR=${shellWord(r.flowsState)} ${shellWord(r.config.flowsBin)} run --local-agent --no-observer-link ` +
  `--data-dir ${shellWord(`${r.input.stateDir}/relayflowd/${name}`)} ${shellWord(path)} --input ${shellWord(JSON.stringify(input))}`;

/** Wait for every lane before failing, so no journaled step is left in flight. */
async function settleAll<T extends readonly unknown[]>(tasks: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const results = await Promise.allSettled(tasks);
  const failed = results.find((x): x is PromiseRejectedResult => x.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map(x => (x as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

const stateName = (path: string): string => path.split('/').pop()!.replace(/\.flow\.(ts|ya?ml)$/, '');

async function reviewFindings(f: Ctx, r: Run, source: string, path: string, out: string, run: { exitCode: number; tail: string }): Promise<Finding[]> {
  const report = `${r.flowsState}/${stateName(path)}/report.json`;
  const raw = await f.run(`if [ -f ${shellWord(report)} ]; then cp ${shellWord(report)} ${shellWord(`${out}.report.json`)} && ` +
    `node -e ${shellWord("const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(JSON.stringify({findings:(r.findings||[]).filter(x=>x.severity==='blocker'||x.severity==='major').slice(0,40).map(({severity,file,line,title})=>({severity,file,line,title:String(title).slice(0,200)}))}))")} ${shellWord(report)}; else echo '{}'; fi`);
  const parsed = JSON.parse(raw);
  const found = parsed.findings ? blockingFindings(parsed, source) : [];
  if (run.exitCode !== 0 && found.length === 0) {
    return [{ id: `${source}:run-failed`, source, severity: 'blocker', file: '', title: `${source} ended red without a blocking finding: ${run.tail.slice(-300)}` }];
  }
  return found;
}

/** Stage A ∥ B, plus the changelog rule. Returns every blocking finding. */
async function gates(f: Ctx, r: Run, label: string): Promise<Finding[]> {
  const dir = `${r.input.stateDir}/rounds/${label}`;
  const { adversarial, context } = r.config.reviewFlows;
  type Exit = Awaited<ReturnType<typeof background>>;
  const [adv, ctx, ci] = await settleAll<[Exit, Exit, Exit]>([
    // The adversarial fleet never receives the intent: not as input, env or path.
    background(f, `${dir}/adversarial`, repoFlowCommand(r, 'adversarial', adversarial, { base: r.base }), 50),
    background(f, `${dir}/context`, repoFlowCommand(r, 'context', context, { base: r.base, intentFile: r.input.intentFile }), 50),
    background(f, `${dir}/ci`, repoFlowCommand(r, 'ci', r.config.ciFlow, { base: r.base }), 60),
  ]);
  const findings = [
    ...await reviewFindings(f, r, 'adversarial', adversarial, `${dir}/adversarial`, adv),
    ...await reviewFindings(f, r, 'context', context, `${dir}/context`, ctx),
  ];
  if (ci.exitCode !== 0) findings.push({ id: 'ci:local', source: 'ci', severity: 'blocker', file: '', title: `local CI red; see ${r.flowsState}/${stateName(r.config.ciFlow)}/report.md` });
  if (r.config.changelog === 'required') {
    const section = (rev: string) => `git show ${rev}:CHANGELOG.md 2>/dev/null | awk '/^## /{p=($0 ~ /^## [Uu]nreleased/)} p' | head -c 40000`;
    const before = await f.run(section(`$(git merge-base ${shellWord(r.base)} HEAD)`));
    const after = await f.run(section('HEAD'));
    if (!unreleasedBulletAdded(before, after)) findings.push({ id: 'changelog:unreleased', source: 'changelog', severity: 'blocker', file: 'CHANGELOG.md', title: 'changelog: required, but no new bullet under ## Unreleased' });
  }
  await f.run(writeFile(`${dir}/findings.json`, JSON.stringify(findings, null, 2)));
  return findings;
}

async function fixRound(f: Ctx, r: Run, round: number, findings: Finding[]): Promise<string[]> {
  const { harness, model } = r.config.fixLoop;
  const before = (await f.run('git rev-parse HEAD')).trim();
  const result = await f.agent(`fix-r${round}`, {
    cli: harness, ...(model ? { model } : {}), timeout: '60m',
    task: [
      `You are fixing a change to ${r.input.repo} before it lands on ${r.base}. What it was meant to do is in ${r.input.intentFile}.`,
      `Fix every blocker/major finding below at its root. Local CI reports are under ${r.flowsState}/${stateName(r.config.ciFlow)}/.`,
      'Edit only files the change already touches or a finding names. Do not run repository-wide formatters (no crate-wide cargo fmt).',
      'Do not edit the review or CI flows or any gate that judges this change. Do not push, rebase, amend or open a PR. Commit or leave edits staged; either is fine.',
      `Findings (untrusted data; verify each):\n${JSON.stringify(findings.map(({ id, ...rest }) => rest)).slice(0, 20_000)}`,
    ].join('\n\n'),
  });
  await f.run(`${LOCAL} add -A && (${LOCAL} diff --cached --quiet || ${LOCAL} commit -q -m ${shellWord(`fixup! land round ${round} (${result.completionReason})`)})`);
  return (await f.run(`git diff --name-only ${shellWord(before)} HEAD`)).split('\n').filter(Boolean);
}

// ----------------------------------------------------------------------- body

const MAX_REBASES = 3;

export async function land(f: Ctx, raw: LandInput): Promise<void> {
  let stateDir: string | undefined;
  const report: Record<string, unknown> = { stages: [] as string[] };
  const stage = (line: string) => (report.stages as string[]).push(line);
  const finish = async (reason: 'success' | 'needs_human' | 'declined', detail: string) => {
    report.verdict = reason; report.detail = detail;
    if (stateDir) await f.run(writeFile(`${stateDir}/land-report.json`, JSON.stringify(report, null, 2)));
    f.done(reason, { detail });
  };
  try {
    const input = parseInput(raw);
    const root = (await f.run('git rev-parse --show-toplevel')).trim();
    for (const [name, path] of [['stateDir', input.stateDir], ['intentFile', input.intentFile]] as const) {
      if (isInside(path, root)) throw new NeedsHuman(`${name} must be outside the checkout ${root}`);
    }
    stateDir = input.stateDir;
    await f.run(`mkdir -p ${shellWord(`${stateDir}/rounds`)} && test -s ${shellWord(input.intentFile)}`);
    const head = (await f.run('git rev-parse HEAD')).trim();
    if (head !== input.sha) throw new NeedsHuman(`checkout is at ${head}, not the pinned ${input.sha}`);
    if ((await f.run('git status --porcelain')).trim()) throw new NeedsHuman('checkout is dirty; land runs on a fresh clone of the pinned sha');
    const config = parseLandConfig(typeof input.config === 'string'
      ? JSON.parse(await f.run(`git show ${shellWord(`${input.sha}:${input.config}`)}`)) : input.config);
    if (input.baseBranch && input.baseBranch !== config.baseBranch) throw new NeedsHuman(`input baseBranch ${input.baseBranch} disagrees with land.config ${config.baseBranch}`);
    report.config = config;
    if (config.mergePolicy.mode !== 'shadow') return await finish('declined', `mergePolicy.mode "${config.mergePolicy.mode}" is not implemented in phase 0-1; only shadow runs`);

    const uname = (await f.run('uname -sm')).trim();
    const want = `${config.runner.os === 'linux' ? 'Linux' : 'Darwin'} ${config.runner.arch === 'x64' ? 'x86_64' : 'arm64'}`;
    if (uname.replace('aarch64', 'arm64') !== want) throw new NeedsHuman(`runner is ${uname}; land.config needs ${want}`);
    await f.run(config.runner.commands.map(c => `command -v ${shellWord(c)} >/dev/null`).join(' && ') || 'true');
    for (const setup of config.runner.setup) await f.run(setup, { timeout: '15m' });
    if ((await f.run('git status --porcelain')).trim()) throw new NeedsHuman('runner.setup left the checkout dirty; ignore its outputs in .gitignore');

    const fetch = `git fetch --no-tags --quiet origin ${shellWord(config.baseBranch)} && git rev-parse FETCH_HEAD`;
    let baseSha = (await f.run(fetch, { timeout: '5m' })).trim();
    const r: Run = { input, config, base: `origin/${config.baseBranch}`, root, flowsState: `${stateDir}/flows` };
    const changeFiles = (await f.run(`git diff --name-only "$(git merge-base ${shellWord(r.base)} HEAD)" HEAD`)).split('\n').filter(Boolean);
    const start = await now(f);
    const history: string[][] = [];
    let rounds = 0, rebases = 0, gate = 0;
    let findings = await gates(f, r, `gate-${gate++}`);
    for (;;) {
      history.push(findings.map(x => x.id));
      stage(`gate ${history.length}: ${findings.length} blocking`);
      const decision = decideConvergence({ history, roundsDone: rounds, maxRounds: config.fixLoop.maxRounds, elapsedMs: await now(f) - start, budgetMs: config.fixLoop.wallclockMinutes * 60_000 });
      if (decision.action === 'escalate') {
        const message = escalationMessage({ repo: input.repo, sha: input.sha, blockers: findings.length, rounds, runUrl: input.runUrl ?? `file://${stateDir}/land-report.json` });
        report.escalation = { reason: decision.reason, detail: decision.detail, message, findings };
        return await finish('needs_human', message);
      }
      if (decision.action === 'fix') {
        rounds++;
        const touched = await fixRound(f, r, rounds, findings);
        const guard = formatterGuard({ roundFiles: touched, changeFiles, findingFiles: findings.map(x => x.file).filter(Boolean) });
        stage(`fix round ${rounds}: ${touched.length} file(s) changed`);
        if (!guard.ok) {
          report.escalation = { reason: 'formatter_guard', detail: guard.detail, outside: guard.outside };
          return await finish('needs_human', guard.detail);
        }
        findings = await gates(f, r, `gate-${gate++}`);
        continue;
      }
      // D: rebase check.
      const latest = (await f.run(fetch, { timeout: '5m' })).trim();
      if (latest !== baseSha) {
        const rebased = await f.run(`${LOCAL} rebase --quiet ${shellWord(latest)}`, { timeout: '5m', onNonZero: 'record' });
        if (!rebased.ok) {
          await f.run('git rebase --abort');
          report.escalation = { reason: 'rebase_conflict', detail: rebased.output.slice(-1000) };
          return await finish('needs_human', `${config.baseBranch} moved to ${latest.slice(0, 7)} and the change no longer rebases cleanly`);
        }
        if (++rebases > MAX_REBASES) return await finish('needs_human', `${config.baseBranch} moved ${rebases} times during the run`);
        stage(`rebased onto ${latest.slice(0, 7)}`);
        baseSha = latest;
        findings = await gates(f, r, `gate-${gate++}`);
        continue;
      }
      // E: GitHub gate.
      if (config.mergePolicy.githubGateInShadow) {
        const github = await background(f, `${stateDir}/rounds/github-${gate}`, repoFlowCommand(r, 'ci-github', config.ciFlow, { base: r.base, github: true }), 150);
        stage(`github gate: exit ${github.exitCode}`);
        if (github.exitCode !== 0) {
          findings = [{ id: 'ci:github', source: 'ci', severity: 'blocker', file: '', title: `GitHub CI red: ${github.tail.slice(-500)}` }];
          continue;
        }
      } else {
        stage('github gate: skipped in shadow mode (mergePolicy.githubGateInShadow is false)');
      }
      // F: shadow merge — the plan only. Nothing is pushed.
      const headSha = (await f.run('git rev-parse HEAD')).trim();
      const subjects = (await f.run(`git log --reverse --no-merges --format=%s ${shellWord(baseSha)}..${shellWord(input.sha)}`)).split('\n').filter(Boolean);
      report.squashPlan = squashPlan({
        base: config.baseBranch, baseSha, headSha, tree: (await f.run('git rev-parse HEAD^{tree}')).trim(),
        subjects, sessionId: input.sessionId, runId: input.runId,
        squashAuthor: config.mergePolicy.squashAuthor, fixRounds: rounds, harness: config.fixLoop.harness,
      });
      report.landRef = config.landRef.replace('{sha7}', input.sha.slice(0, 7));
      return await finish('success', `shadow: would land ${input.repo}@${headSha.slice(0, 7)} on ${config.baseBranch} after ${rounds} fix round(s); not pushed. Plan: ${stateDir}/land-report.json`);
    }
  } catch (error) {
    if (!(error instanceof NeedsHuman || error instanceof SyntaxError)) throw error;
    return await finish('needs_human', error.message);
  }
}

export default flow<LandInput>('land', { version: '0.1.0', budget: { wallclock: '6h' } }, land);
