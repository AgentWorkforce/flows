// land — one pinned change (repo, sha, session) reviewed, gated, fixed and,
// in shadow mode, planned as a squash commit that is never pushed. Spec:
// AgentWorkforce/cloud#5806 §5, §7, §8. Phase 0-1: shadow mode only.
//
// ONE HOSTED RUN PER STAGE — the PROPOSED design, pending Khaliq's decision
// on cloud#5806 decision A; not yet decided. Each invocation runs exactly one
// stage, under Cloud's 40-minute run ceiling, against state
// persisted in `<stateDir>/land-state.json`, and ends with a JSON completion
// detail naming the next stage or a terminal state. Cloud's land queue chains
// the runs from that detail:
//
//   flows run examples/land/land.flow.ts --input '{"stage":"A-adversarial","repo":"owner/name",
//     "sha":"<40 hex>","sessionId":"<id>","intentFile":"/runs/<runId>/intent.md","stateDir":"/runs/<runId>"}'
//   → {"land":"next","stage":"A-context","seq":1}
//
//   A-adversarial  the repo's adversarial review. Never given the intent.
//   A-context      the repo's context review, given intentFile.
//   B              the repo's local CI + the changelog rule; closes the gate.
//   C-<n>          fix round n: one fix agent, formatter guard, then A again.
//   D              fetch the base; rebased → A again, conflict → needs_human.
//   E              GitHub gate. Skipped in shadow mode: no write token (cloud#5806 decision B, decided).
//   F              shadow: the would-be squash plan goes into the state. Never push.
//
// Every run starts from a fresh clone of the pinned sha. Fix and rebase
// commits are carried between runs in `<stateDir>/land.bundle`, never pushed.
// The state file is the commit point: a run reaped before writing it reruns
// the same stage from the same state; a rerun after it was written is a no-op
// that reports the cursor again.
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
  runner: {
    os: (typeof RUNNER_OS)[number]; arch: (typeof RUNNER_ARCH)[number]; commands: string[]; setup: string[];
    /** The longest a review, CI or fix step may run inside one hosted stage run (Cloud's ceiling is 40m). */
    stageMinutes: number;
  };
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
  runner: { os: 'linux', arch: 'x64', commands: ['git', 'node'], setup: [] as string[], stageMinutes: 30 },
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
  const runner = object(c.runner ?? {}, '.runner', ['os', 'arch', 'commands', 'setup', 'stageMinutes']);
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
      stageMinutes: integer(runner.stageMinutes ?? D.runner.stageMinutes, '.runner.stageMinutes', 5, 35),
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
  /** The one stage this hosted run executes; Cloud chains runs from the previous completion detail (proposed, pending cloud#5806 decision A). */
  stage: string;
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
  /** Linked from an escalation; defaults to the state file's path. */
  runUrl?: string;
  /** The land ref (branch name) the change was pushed to. When given, each stage checks it still points at `sha`. */
  ref?: string;
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
    stage: check(input.stage, 'stage', STAGE) as Stage,
    repo: check(input.repo, 'repo', /^[\w.-]+\/[\w.-]+$/),
    sha: check(input.sha, 'sha', /^[0-9a-f]{40}$/),
    baseBranch: input.baseBranch === undefined ? undefined : check(input.baseBranch, 'baseBranch', /^(?!-)(?!.*\.\.)[A-Za-z0-9_.\/-]+$/),
    sessionId: check(input.sessionId, 'sessionId', /^[A-Za-z0-9_.:-]{1,128}$/),
    intentFile: check(input.intentFile, 'intentFile', STATE_PATH),
    stateDir,
    config: input.config ?? 'land.config.json',
    runUrl: input.runUrl === undefined ? undefined : check(input.runUrl, 'runUrl', /^https:\/\/[^\s]+$/),
    ref: input.ref === undefined ? undefined : check(input.ref, 'ref', /^(?!-)(?!.*\.\.)[A-Za-z0-9_.\/-]+$/),
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

// ---------------------------------------------------------------- state machine

export type Stage = 'A-adversarial' | 'A-context' | 'B' | `C-${number}` | 'D' | 'E' | 'F';
export type Terminal = 'landed' | 'needs_human' | 'cancelled' | 'failed';
const STAGE = /^(A-adversarial|A-context|B|C-[1-9][0-9]?|D|E|F)$/;
export const STATE_VERSION = 1;
export const MAX_REBASES = 3;

export interface LandState {
  version: typeof STATE_VERSION;
  /** Bumped by every transition: an idempotency key for the stage that produced it. */
  seq: number;
  repo: string; pinnedSha: string; sessionId: string; runId: string; runUrl: string;
  config: LandConfig;
  /** The current land-ref sha: pinnedSha plus local fixups and rebases. */
  headSha: string;
  baseSha: string;
  changeFiles: string[];
  startedAt: number;
  cursor: Stage | null;
  terminal: { state: Terminal; detail: string } | null;
  /** Fix rounds done. */
  round: number;
  rebases: number;
  /** The open gate's lane results; cleared when a gate closes or the head changes. */
  lanes: { adversarial?: Finding[]; context?: Finding[] };
  /** Every closed gate's blocking finding ids, oldest first: the convergence input. */
  history: string[][];
  gates: Array<{ head: string; blocking: number; ids: string[] }>;
  findings: Finding[];
  log: string[];
  escalation?: { reason: string; detail: string; message?: string };
  squashPlan?: SquashPlan;
}

export type StageResult = { now: number } & (
  | { kind: 'superseded'; refSha: string | null }
  | { kind: 'review'; lane: 'adversarial' | 'context'; findings: Finding[] }
  | { kind: 'ci'; findings: Finding[] }
  | { kind: 'fix'; headSha: string; guard: { ok: boolean; detail: string } }
  | { kind: 'rebase'; outcome: 'unchanged' | 'rebased' | 'conflict'; baseSha: string; headSha: string; detail?: string }
  | { kind: 'github'; green: boolean; detail: string }
  | { kind: 'merge'; plan: SquashPlan }
);

const KIND: Record<string, StageResult['kind']> = { 'A-adversarial': 'review', 'A-context': 'review', B: 'ci', D: 'rebase', E: 'github', F: 'merge' };

export function initialState(p: Pick<LandState, 'repo' | 'pinnedSha' | 'sessionId' | 'runId' | 'runUrl' | 'config' | 'baseSha' | 'changeFiles' | 'startedAt'>): LandState {
  return { version: STATE_VERSION, seq: 0, ...p, headSha: p.pinnedSha, cursor: 'A-adversarial', terminal: null, round: 0, rebases: 0, lanes: {}, history: [], gates: [], findings: [], log: [] };
}

/** Pure: the state after `state.cursor` produced `result`. Never mutates `state`. */
export function nextLandStage(state: LandState, result: StageResult): LandState {
  if (state.terminal || !state.cursor) throw new Error(`run is already ${state.terminal?.state}`);
  const s: LandState = structuredClone(state);
  s.seq++;
  const at = state.cursor;
  const end = (terminal: Terminal, detail: string): LandState => { s.cursor = null; s.terminal = { state: terminal, detail }; s.log.push(`${at}: ${terminal}`); return s; };
  const escalate = (reason: string, detail: string): LandState => { s.escalation = { reason, detail }; return end('needs_human', detail); };
  const regate = (head: string) => { s.headSha = head; s.lanes = {}; s.cursor = 'A-adversarial'; };
  if (result.kind === 'superseded') return end('cancelled', `superseded: land ref now ${result.refSha ?? 'deleted'}, run pinned ${state.pinnedSha}`);
  const want = at.startsWith('C-') ? 'fix' : KIND[at];
  if (result.kind !== want) throw new Error(`stage ${at} cannot take a ${result.kind} result`);

  const closeGate = (findings: Finding[]): LandState => {
    const ids = findings.map(x => x.id);
    s.history.push(ids); s.gates.push({ head: s.headSha, blocking: ids.length, ids }); s.findings = findings; s.lanes = {};
    const decision = decideConvergence({ history: s.history, roundsDone: s.round, maxRounds: s.config.fixLoop.maxRounds, elapsedMs: result.now - s.startedAt, budgetMs: s.config.fixLoop.wallclockMinutes * 60_000 });
    s.log.push(`${at}: gate ${s.gates.length} closed with ${ids.length} blocking`);
    if (decision.action === 'proceed') { s.cursor = 'D'; return s; }
    if (decision.action === 'fix') { s.cursor = `C-${s.round + 1}`; return s; }
    const message = escalationMessage({ repo: s.repo, sha: s.pinnedSha, blockers: ids.length, rounds: s.round, runUrl: s.runUrl });
    s.escalation = { reason: decision.reason, detail: decision.detail, message };
    return end('needs_human', message);
  };

  switch (result.kind) {
    case 'review':
      s.lanes[result.lane] = result.findings;
      s.cursor = result.lane === 'adversarial' ? 'A-context' : 'B';
      return s;
    case 'ci':
      return closeGate([...s.lanes.adversarial ?? [], ...s.lanes.context ?? [], ...result.findings]);
    case 'fix':
      s.round = Number(at.slice(2));
      if (!result.guard.ok) return escalate('formatter_guard', result.guard.detail);
      s.log.push(`${at}: head ${result.headSha.slice(0, 7)}`);
      regate(result.headSha);
      return s;
    case 'rebase':
      if (result.outcome === 'conflict') return escalate('rebase_conflict', `${s.config.baseBranch} moved to ${result.baseSha.slice(0, 7)} and the change no longer rebases cleanly`);
      if (result.outcome === 'unchanged') {
        const skip = s.config.mergePolicy.mode === 'shadow' && !s.config.mergePolicy.githubGateInShadow;
        if (skip) s.log.push('E: skipped in shadow mode');
        s.cursor = skip ? 'F' : 'E';
        return s;
      }
      if (++s.rebases > MAX_REBASES) return escalate('base_churn', `${s.config.baseBranch} moved ${s.rebases} times during the run`);
      s.baseSha = result.baseSha;
      s.log.push(`D: rebased onto ${result.baseSha.slice(0, 7)}`);
      regate(result.headSha);
      return s;
    case 'github':
      if (result.green) { s.cursor = 'F'; return s; }
      return closeGate([{ id: 'ci:github', source: 'ci', severity: 'blocker', file: '', title: `GitHub CI red: ${result.detail.slice(-500)}` }]);
    case 'merge':
      s.squashPlan = result.plan;
      return end('landed', `shadow: would land ${s.repo}@${result.plan.headSha.slice(0, 7)} on ${s.config.baseBranch} after ${s.round} fix round(s); not pushed`);
  }
}

/** The completion detail Cloud chains on. */
export function completionDetail(s: LandState, noop = false): string {
  return JSON.stringify(s.terminal
    ? { land: 'terminal', state: s.terminal.state, seq: s.seq, detail: s.terminal.detail }
    : { land: 'next', stage: s.cursor, seq: s.seq, ...(noop ? { noop: true } : {}) });
}

export function parseState(raw: string): LandState | null {
  const value = JSON.parse(raw);
  if (value === null) return null;
  if (value?.version !== STATE_VERSION) throw new NeedsHuman(`land-state.json version ${value?.version}; this flow reads ${STATE_VERSION}`);
  if (typeof value.pinnedSha !== 'string' || typeof value.seq !== 'number' || !Array.isArray(value.history)) throw new NeedsHuman('land-state.json is malformed');
  return { ...value, config: parseLandConfig(value.config) };
}

// ---------------------------------------------------------------------- steps

const POLL_SECONDS = 300;
const LOCAL = 'git -c user.name=relay-land -c user.email=relay-land@localhost'; // sandbox-only commits; never pushed

const now = async (f: Ctx): Promise<number> => {
  const raw = (await f.run('node -p Date.now()', { timeout: '5s' })).trim();
  if (!/^\d+$/.test(raw)) throw new Error('invalid journaled clock');
  return Number(raw);
};

/** Written to a temporary name and renamed, so a reaped run never leaves half a file. */
const writeFile = (path: string, content: string): string =>
  `printf %s ${shellWord(Buffer.from(content, 'utf8').toString('base64'))} | base64 -d > ${shellWord(`${path}.tmp`)} && mv ${shellWord(`${path}.tmp`)} ${shellWord(path)}`;

/**
 * A repo flow runs longer than one f.run lease (15m), so it runs detached
 * inside this stage's sandbox and is polled in 5-minute steps, never past
 * runner.stageMinutes. Nothing outlives the hosted run.
 */
export async function background(f: Ctx, dir: string, command: string, minutes: number): Promise<{ exitCode: number; tail: string }> {
  const exit = `${dir}/exit`;
  await f.run(`mkdir -p ${shellWord(dir)} && rm -f ${shellWord(exit)} && ` +
    `{ nohup sh -c ${shellWord(`${command}; echo $? > ${exit}.tmp && mv ${exit}.tmp ${exit}`)} > ${shellWord(`${dir}/log`)} 2>&1 < /dev/null & } && echo started`);
  for (let poll = 0; poll * POLL_SECONDS < minutes * 60; poll++) {
    const seconds = Math.min(POLL_SECONDS, minutes * 60 - poll * POLL_SECONDS);
    const out = (await f.run(`for i in $(seq 1 ${seconds}); do if [ -f ${shellWord(exit)} ]; then cat ${shellWord(exit)}; exit 0; fi; sleep 1; done; echo pending`, { timeout: '6m' })).trim();
    if (out !== 'pending') return { exitCode: Number(out), tail: await f.run(`tail -c 1500 ${shellWord(`${dir}/log`)}`) };
  }
  throw new NeedsHuman(`${dir.split('/').pop()} did not finish within runner.stageMinutes (${minutes}m); log at ${dir}/log`);
}

interface Run { input: ReturnType<typeof parseInput>; state: LandState; base: string; flowsState: string; dir: string }

/** The nested `flows run` for a repo flow. Its journal and its state both live under stateDir. */
export const repoFlowCommand = (r: Run, name: string, path: string, input: unknown): string =>
  `RELAYFLOW_STATE_DIR=${shellWord(r.flowsState)} ${shellWord(r.state.config.flowsBin)} run --local-agent --no-observer-link ` +
  `--data-dir ${shellWord(`${r.input.stateDir}/relayflowd/${name}`)} ${shellWord(path)} --input ${shellWord(JSON.stringify(input))}`;

const stateName = (path: string): string => path.split('/').pop()!.replace(/\.flow\.(ts|ya?ml)$/, '');

async function review(f: Ctx, r: Run, lane: 'adversarial' | 'context'): Promise<Finding[]> {
  const path = r.state.config.reviewFlows[lane];
  // The adversarial fleet never receives the intent: not as input, env or path.
  const input = lane === 'context' ? { base: r.base, intentFile: r.input.intentFile } : { base: r.base };
  const run = await background(f, `${r.dir}/${lane}`, repoFlowCommand(r, lane, path, input), r.state.config.runner.stageMinutes);
  const report = `${r.flowsState}/${stateName(path)}/report.json`;
  const raw = await f.run(`if [ -f ${shellWord(report)} ]; then cp ${shellWord(report)} ${shellWord(`${r.dir}/${lane}.report.json`)} && ` +
    `node -e ${shellWord("const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(JSON.stringify({findings:(r.findings||[]).filter(x=>x.severity==='blocker'||x.severity==='major').slice(0,40).map(({severity,file,line,title})=>({severity,file,line,title:String(title).slice(0,200)}))}))")} ${shellWord(report)}; else echo '{}'; fi`);
  const parsed = JSON.parse(raw);
  const found = parsed.findings ? blockingFindings(parsed, lane) : [];
  if (run.exitCode !== 0 && found.length === 0) {
    return [{ id: `${lane}:run-failed`, source: lane, severity: 'blocker', file: '', title: `${lane} ended red without a blocking finding: ${run.tail.slice(-300)}` }];
  }
  return found;
}

async function localCi(f: Ctx, r: Run): Promise<Finding[]> {
  const { ciFlow, changelog, runner } = r.state.config;
  const ci = await background(f, `${r.dir}/ci`, repoFlowCommand(r, 'ci', ciFlow, { base: r.base }), runner.stageMinutes);
  const findings: Finding[] = [];
  if (ci.exitCode !== 0) findings.push({ id: 'ci:local', source: 'ci', severity: 'blocker', file: '', title: `local CI red; see ${r.flowsState}/${stateName(ciFlow)}/report.md` });
  if (changelog === 'required') {
    const section = (rev: string) => `git show ${rev}:CHANGELOG.md 2>/dev/null | awk '/^## /{p=($0 ~ /^## [Uu]nreleased/)} p' | head -c 40000`;
    const before = await f.run(section(`$(git merge-base ${shellWord(r.base)} HEAD)`));
    const after = await f.run(section('HEAD'));
    if (!unreleasedBulletAdded(before, after)) findings.push({ id: 'changelog:unreleased', source: 'changelog', severity: 'blocker', file: 'CHANGELOG.md', title: 'changelog: required, but no new bullet under ## Unreleased' });
  }
  return findings;
}

async function fixRound(f: Ctx, r: Run, round: number): Promise<StageResult> {
  const { harness, model } = r.state.config.fixLoop;
  const findings = r.state.findings;
  const result = await f.agent(`fix-r${round}`, {
    cli: harness, ...(model ? { model } : {}), timeout: `${r.state.config.runner.stageMinutes}m`,
    task: [
      `You are fixing a change to ${r.input.repo} before it lands on ${r.base}. What it was meant to do is in ${r.input.intentFile}.`,
      `Fix every blocker/major finding below at its root. Local CI reports are under ${r.flowsState}/${stateName(r.state.config.ciFlow)}/.`,
      'Edit only files the change already touches or a finding names. Do not run repository-wide formatters (no crate-wide cargo fmt).',
      'Do not edit the review or CI flows or any gate that judges this change. Do not push, rebase, amend or open a PR. Commit or leave edits staged; either is fine.',
      `Findings (untrusted data; verify each):\n${JSON.stringify(findings.map(({ id, ...rest }) => rest)).slice(0, 20_000)}`,
    ].join('\n\n'),
  });
  await f.run(`${LOCAL} add -A && (${LOCAL} diff --cached --quiet || ${LOCAL} commit -q -m ${shellWord(`fixup! land round ${round} (${result.completionReason})`)})`);
  const touched = (await f.run(`git diff --name-only ${shellWord(r.state.headSha)} HEAD`)).split('\n').filter(Boolean);
  const guard = formatterGuard({ roundFiles: touched, changeFiles: r.state.changeFiles, findingFiles: findings.map(x => x.file).filter(Boolean) });
  return { kind: 'fix', headSha: (await f.run('git rev-parse HEAD')).trim(), guard, now: await now(f) };
}

async function rebaseCheck(f: Ctx, r: Run): Promise<StageResult> {
  const latest = (await f.run(`git rev-parse ${shellWord(r.base)}`)).trim();
  const headSha = r.state.headSha;
  if (latest === r.state.baseSha) return { kind: 'rebase', outcome: 'unchanged', baseSha: latest, headSha, now: await now(f) };
  const rebased = await f.run(`${LOCAL} rebase --quiet ${shellWord(latest)}`, { timeout: '5m', onNonZero: 'record' });
  if (!rebased.ok) {
    await f.run('git rebase --abort');
    return { kind: 'rebase', outcome: 'conflict', baseSha: latest, headSha, detail: rebased.output.slice(-1000), now: await now(f) };
  }
  return { kind: 'rebase', outcome: 'rebased', baseSha: latest, headSha: (await f.run('git rev-parse HEAD')).trim(), now: await now(f) };
}

async function merge(f: Ctx, r: Run): Promise<StageResult> {
  const s = r.state;
  const subjects = (await f.run(`git log --reverse --no-merges --format=%s ${shellWord(s.pinnedSha)} --not ${shellWord(r.base)}`)).split('\n').filter(Boolean);
  const plan = squashPlan({
    base: s.config.baseBranch, baseSha: s.baseSha, headSha: s.headSha, tree: (await f.run('git rev-parse HEAD^{tree}')).trim(),
    subjects, sessionId: s.sessionId, runId: s.runId, squashAuthor: s.config.mergePolicy.squashAuthor, fixRounds: s.round, harness: s.config.fixLoop.harness,
  });
  return { kind: 'merge', plan, now: await now(f) };
}

async function runStage(f: Ctx, r: Run): Promise<StageResult> {
  const at = r.state.cursor!;
  if (at === 'A-adversarial' || at === 'A-context') {
    const lane = at === 'A-adversarial' ? 'adversarial' : 'context';
    return { kind: 'review', lane, findings: await review(f, r, lane), now: await now(f) };
  }
  if (at === 'B') return { kind: 'ci', findings: await localCi(f, r), now: await now(f) };
  if (at === 'D') return rebaseCheck(f, r);
  if (at === 'E') {
    const github = await background(f, `${r.dir}/github`, repoFlowCommand(r, 'ci-github', r.state.config.ciFlow, { base: r.base, github: true }), r.state.config.runner.stageMinutes);
    return { kind: 'github', green: github.exitCode === 0, detail: github.tail, now: await now(f) };
  }
  if (at === 'F') return merge(f, r);
  return fixRound(f, r, Number(at.slice(2)));
}

// ----------------------------------------------------------------------- body

const REASON: Record<Terminal, 'success' | 'needs_human' | 'canceled' | 'step_failed'> = { landed: 'success', needs_human: 'needs_human', cancelled: 'canceled', failed: 'step_failed' };

export async function land(f: Ctx, raw: LandInput): Promise<void> {
  let stateFile: string | undefined;
  let owned: LandState | undefined; // set once this run holds the cursor; a failure then becomes the run's verdict
  try {
    const input = parseInput(raw);
    const root = (await f.run('git rev-parse --show-toplevel')).trim();
    for (const [name, path] of [['stateDir', input.stateDir], ['intentFile', input.intentFile]] as const) {
      if (isInside(path, root)) throw new NeedsHuman(`${name} must be outside the checkout ${root}`);
    }
    stateFile = `${input.stateDir}/land-state.json`;
    await f.run(`mkdir -p ${shellWord(`${input.stateDir}/stages`)} && test -s ${shellWord(input.intentFile)}`);
    const head = (await f.run('git rev-parse HEAD')).trim();
    if (head !== input.sha) throw new NeedsHuman(`checkout is at ${head}, not the pinned ${input.sha}`);
    if ((await f.run('git status --porcelain')).trim()) throw new NeedsHuman('checkout is dirty; land runs on a fresh clone of the pinned sha');

    let state = parseState(await f.run(`cat ${shellWord(stateFile)} 2>/dev/null || echo null`));
    if (state && (state.repo !== input.repo || state.pinnedSha !== input.sha || state.sessionId !== input.sessionId)) {
      throw new NeedsHuman(`land-state.json belongs to ${state.repo}@${state.pinnedSha.slice(0, 7)} session ${state.sessionId}`);
    }
    if (!state && input.stage !== 'A-adversarial') throw new NeedsHuman(`no land-state.json under ${input.stateDir}; a run starts at A-adversarial`);
    if (state?.terminal) return f.done(REASON[state.terminal.state], { detail: completionDetail(state) });
    if (state && input.stage !== state.cursor) return f.done('success', { detail: completionDetail(state, true) });

    const config = state?.config ?? parseLandConfig(typeof input.config === 'string'
      ? JSON.parse(await f.run(`git show ${shellWord(`${input.sha}:${input.config}`)}`)) : input.config);
    if (input.baseBranch && input.baseBranch !== config.baseBranch) throw new NeedsHuman(`input baseBranch ${input.baseBranch} disagrees with land.config ${config.baseBranch}`);
    if (config.mergePolicy.mode !== 'shadow') return f.done('declined', { detail: JSON.stringify({ land: 'declined', detail: `mergePolicy.mode "${config.mergePolicy.mode}" is not implemented in phase 0-1; only shadow runs` }) });

    const uname = (await f.run('uname -sm')).trim();
    const want = `${config.runner.os === 'linux' ? 'Linux' : 'Darwin'} ${config.runner.arch === 'x64' ? 'x86_64' : 'arm64'}`;
    if (uname.replace('aarch64', 'arm64') !== want) throw new NeedsHuman(`runner is ${uname}; land.config needs ${want}`);
    await f.run(config.runner.commands.map(c => `command -v ${shellWord(c)} >/dev/null`).join(' && ') || 'true');
    const base = `origin/${config.baseBranch}`;
    await f.run(`git fetch --no-tags --quiet origin ${shellWord(`+refs/heads/${config.baseBranch}:refs/remotes/${base}`)}`, { timeout: '5m' });

    if (!state) {
      const runUrl = input.runUrl ?? `file://${stateFile}`;
      escalationMessage({ repo: input.repo, sha: input.sha, blockers: 999, rounds: 10, runUrl }); // refuse now a URL no escalation could carry
      state = initialState({
        repo: input.repo, pinnedSha: input.sha, sessionId: input.sessionId, runId: input.runId, runUrl, config,
        baseSha: (await f.run(`git rev-parse ${shellWord(base)}`)).trim(),
        changeFiles: (await f.run(`git diff --name-only "$(git merge-base ${shellWord(base)} HEAD)" HEAD`)).split('\n').filter(Boolean),
        startedAt: await now(f),
      });
    }
    owned = state;
    if (input.ref) {
      const refSha = (await f.run(`git ls-remote origin ${shellWord(`refs/heads/${input.ref}`)} | cut -f1`)).trim() || null;
      if (refSha !== state.pinnedSha) return await save(f, stateFile, nextLandStage(state, { kind: 'superseded', refSha, now: await now(f) }));
    }
    if (state.headSha !== state.pinnedSha) {
      const restored = (await f.run(`git fetch --quiet ${shellWord(`${input.stateDir}/land.bundle`)} HEAD && git checkout --quiet --detach FETCH_HEAD && git rev-parse HEAD`)).trim();
      if (restored !== state.headSha) throw new NeedsHuman(`land.bundle holds ${restored}, state expects ${state.headSha}`);
    }
    for (const setup of config.runner.setup) await f.run(setup, { timeout: '15m' });
    if ((await f.run('git status --porcelain')).trim()) throw new NeedsHuman('runner.setup left the checkout dirty; ignore its outputs in .gitignore');

    const r: Run = { input, state, base, flowsState: `${input.stateDir}/flows`, dir: `${input.stateDir}/stages/${state.seq}-${state.cursor}` };
    const next = nextLandStage(state, await runStage(f, r));
    if (next.headSha !== state.headSha) {
      const bundle = `${input.stateDir}/land.bundle`;
      await f.run(`git bundle create --quiet ${shellWord(`${bundle}.tmp`)} HEAD --not ${shellWord(state.pinnedSha)} ${shellWord(base)} && mv ${shellWord(`${bundle}.tmp`)} ${shellWord(bundle)}`);
    }
    return await save(f, stateFile, next);
  } catch (error) {
    if (!(error instanceof NeedsHuman || error instanceof SyntaxError)) throw error;
    if (!owned || !stateFile) return f.done('needs_human', { detail: JSON.stringify({ land: 'refused', detail: error.message }) });
    const s: LandState = { ...structuredClone(owned), seq: owned.seq + 1, cursor: null, terminal: { state: 'needs_human', detail: error.message }, escalation: { reason: 'stage_error', detail: error.message } };
    return await save(f, stateFile, s);
  }
}

/** The state write is the stage's commit point; the completion detail repeats what it says. */
async function save(f: Ctx, stateFile: string, s: LandState): Promise<void> {
  await f.run(writeFile(stateFile, JSON.stringify(s, null, 2)));
  f.done(s.terminal ? REASON[s.terminal.state] : 'success', { detail: completionDetail(s) });
}

// One stage per run (proposed, pending cloud#5806 decision A): the budget sits under Cloud's 40-minute run ceiling.
export default flow<LandInput>('land', { version: '0.2.0', budget: { wallclock: '40m' } }, land);
