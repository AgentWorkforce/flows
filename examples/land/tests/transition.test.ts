import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nextLandStage, initialState, completionDetail, parseState, parseLandConfig, squashPlan,
  type LandState, type StageResult, type Finding,
} from '../land.flow.ts';

const sha = 'a'.repeat(40);
const config = parseLandConfig({ reviewFlows: { adversarial: 'flows/adversarial-review.flow.ts', context: 'flows/context-review.flow.ts' }, ciFlow: 'flows/ci.flow.ts' });
const start = (over: Partial<Parameters<typeof initialState>[0]> = {}): LandState => initialState({
  repo: 'AgentWorkforce/relay-desktop', pinnedSha: sha, sessionId: 's-1', runId: 'run-1', runUrl: 'https://agentrelay.com/r/run-1',
  config, baseSha: 'b'.repeat(40), changeFiles: ['a.rs'], startedAt: 0, ...over,
});
const f = (id: string): Finding => ({ id, source: 'adversarial', severity: 'blocker', file: 'a.rs', title: id });
const t = 60_000;
const review = (lane: 'adversarial' | 'context', ids: string[] = [], now = t): StageResult => ({ kind: 'review', lane, findings: ids.map(f), now });
const ci = (ids: string[] = [], now = t): StageResult => ({ kind: 'ci', findings: ids.map(f), now });
const fixed = (head: string, ok = true): StageResult => ({ kind: 'fix', headSha: head, guard: { ok, detail: ok ? '' : 'fix round touched 2 file(s) outside change ∪ findings' }, now: t });
const rebase = (outcome: 'unchanged' | 'rebased' | 'conflict', baseSha = 'b'.repeat(40), headSha = sha): StageResult => ({ kind: 'rebase', outcome, baseSha, headSha, now: t });
const wouldDispatch = (): StageResult => ({ kind: 'github', wouldDispatch: { flow: 'flows/ci.flow.ts', input: { base: 'origin/main', github: true }, headSha: sha, dispatched: false }, now: t });
const plan = squashPlan({ base: 'main', baseSha: 'b'.repeat(40), headSha: sha, tree: 't'.repeat(40), subjects: ['feat: x'], sessionId: 's-1', runId: 'run-1', squashAuthor: 'session-human', fixRounds: 0, harness: 'claude' });

/** Feed one gate (A-adversarial, A-context, B) with the given adversarial ids. */
const gate = (s: LandState, ids: string[], now = t): LandState =>
  nextLandStage(nextLandStage(nextLandStage(s, review('adversarial', ids, now)), review('context', [], now)), ci([], now));

test('clean run: A-adversarial → A-context → B → D → E (would dispatch) → F → landed', () => {
  const cursors: Array<string | null> = [];
  let s = start();
  for (const r of [review('adversarial'), review('context'), ci(), rebase('unchanged'), wouldDispatch(), { kind: 'merge', plan, now: t } as StageResult]) {
    cursors.push(s.cursor); s = nextLandStage(s, r);
  }
  assert.deepEqual(cursors, ['A-adversarial', 'A-context', 'B', 'D', 'E', 'F']);
  assert.equal(s.terminal?.state, 'landed');
  assert.equal(s.squashPlan?.pushed, false);
  assert.ok(s.log.includes('E: shadow: would dispatch flows/ci.flow.ts {"github":true} at aaaaaaa'));
  assert.equal(s.githubGate?.dispatched, false);
  assert.equal(s.seq, 6);
  assert.deepEqual(JSON.parse(completionDetail(s)).state, 'landed');
});

test('E in shadow always reports would-dispatch and moves on to F, without closing a gate', () => {
  const atE = nextLandStage(gate(start(), []), rebase('unchanged'));
  assert.equal(atE.cursor, 'E');
  const next = nextLandStage(atE, wouldDispatch());
  assert.equal(next.cursor, 'F');
  assert.deepEqual(next.githubGate, { flow: 'flows/ci.flow.ts', input: { base: 'origin/main', github: true }, headSha: sha, dispatched: false });
  assert.equal(next.history.length, atE.history.length);
  assert.equal(next.round, 0);
});

test('the gate unions all three lanes and feeds the fix round', () => {
  let s = nextLandStage(start(), review('adversarial', ['adv']));
  s = nextLandStage(s, review('context', ['ctx']));
  s = nextLandStage(s, ci(['ci:local']));
  assert.equal(s.cursor, 'C-1');
  assert.deepEqual(s.findings.map(x => x.id), ['adv', 'ctx', 'ci:local']);
  assert.deepEqual(s.lanes, {});
  s = nextLandStage(s, fixed('c'.repeat(40)));
  assert.equal(s.cursor, 'A-adversarial');
  assert.equal(s.round, 1);
  assert.equal(s.headSha, 'c'.repeat(40));
  assert.equal(s.pinnedSha, sha);
});

test('convergence stop: the same finding id surviving 2 consecutive rounds', () => {
  let s = gate(start(), ['x', 'y']);
  s = gate(nextLandStage(s, fixed('c'.repeat(40))), ['x']);
  s = gate(nextLandStage(s, fixed('d'.repeat(40))), ['x']);
  assert.equal(s.terminal?.state, 'needs_human');
  assert.equal(s.escalation?.reason, 'stuck_finding');
  assert.equal(s.terminal?.detail, 'Land AgentWorkforce/relay-desktop@aaaaaaa stuck: 1 blockers after 2 rounds. Fix or abort? https://agentrelay.com/r/run-1');
  assert.ok(Buffer.byteLength(s.terminal!.detail) <= 150);
});

test('convergence stop: count not decreasing for 2 rounds', () => {
  let s = gate(start(), ['a', 'b']);
  s = gate(nextLandStage(s, fixed('c'.repeat(40))), ['c', 'd']);
  s = gate(nextLandStage(s, fixed('d'.repeat(40))), ['e', 'f']);
  assert.equal(s.escalation?.reason, 'not_decreasing');
});

test('convergence stop: round cap and wallclock budget', () => {
  const capped = start({ config: { ...config, fixLoop: { ...config.fixLoop, maxRounds: 1 } } });
  let s = gate(capped, ['a', 'b']);
  s = gate(nextLandStage(s, fixed('c'.repeat(40))), ['c']);
  assert.equal(s.escalation?.reason, 'round_cap');
  const late = gate(start(), ['a'], 180 * 60_000);
  assert.equal(late.escalation?.reason, 'budget');
});

test('formatter guard breach and rebase conflict end needs_human; a clean rebase regates', () => {
  const atC = gate(start(), ['a']);
  const guard = nextLandStage(atC, fixed('c'.repeat(40), false));
  assert.equal(guard.terminal?.state, 'needs_human');
  assert.equal(guard.escalation?.reason, 'formatter_guard');

  const atD = gate(start(), []);
  assert.equal(nextLandStage(atD, rebase('conflict', 'c'.repeat(40))).escalation?.reason, 'rebase_conflict');
  const rebased = nextLandStage(atD, rebase('rebased', 'c'.repeat(40), 'e'.repeat(40)));
  assert.equal(rebased.cursor, 'A-adversarial');
  assert.equal(rebased.baseSha, 'c'.repeat(40));
  assert.equal(rebased.headSha, 'e'.repeat(40));
  assert.equal(rebased.rebases, 1);
  let churn = atD;
  for (let i = 0; i < 3; i++) churn = gate(nextLandStage(churn, rebase('rebased', String(i).repeat(40), 'e'.repeat(40))), []);
  assert.equal(nextLandStage(churn, rebase('rebased', '9'.repeat(40), 'e'.repeat(40))).escalation?.reason, 'base_churn');
});

test('superseded: the land ref moved (or was deleted) → cancelled, from any stage', () => {
  for (const s of [start(), gate(start(), ['a']), gate(start(), [])]) {
    const next = nextLandStage(s, { kind: 'superseded', refSha: 'f'.repeat(40), now: t });
    assert.equal(next.terminal?.state, 'cancelled');
    assert.match(next.terminal!.detail, /superseded: land ref now f{40}/);
  }
  assert.match(nextLandStage(start(), { kind: 'superseded', refSha: null, now: t }).terminal!.detail, /now deleted/);
});

test('pure and fail-closed: no mutation, wrong result kinds and terminal states refused', () => {
  const s = start();
  const before = JSON.stringify(s);
  nextLandStage(s, review('adversarial', ['a']));
  assert.equal(JSON.stringify(s), before);
  assert.throws(() => nextLandStage(s, ci()), /stage A-adversarial cannot take a ci result/);
  assert.throws(() => nextLandStage(gate(start(), ['a']), review('adversarial')), /stage C-1 cannot take a review/);
  const done = nextLandStage(s, { kind: 'superseded', refSha: null, now: t });
  assert.throws(() => nextLandStage(done, review('adversarial')), /already cancelled/);
});

test('idempotent: the same state and result always give the same next state', () => {
  const s = gate(start(), ['a']);
  assert.deepEqual(nextLandStage(s, fixed('c'.repeat(40))), nextLandStage(s, fixed('c'.repeat(40))));
});

test('land-state.json round-trips and refuses other versions', () => {
  const s = gate(start(), ['a']);
  assert.deepEqual(parseState(JSON.stringify(s)), s);
  assert.equal(parseState('null'), null);
  assert.throws(() => parseState(JSON.stringify({ ...s, version: 2 })), /version 2/);
  assert.throws(() => parseState(JSON.stringify({ ...s, config: { ...s.config, bogus: 1 } })), /unknown key/);
  assert.deepEqual(JSON.parse(completionDetail(s)), { land: 'next', stage: 'C-1', seq: 3 });
  assert.deepEqual(JSON.parse(completionDetail(s, true)), { land: 'next', stage: 'C-1', seq: 3, noop: true });
});
