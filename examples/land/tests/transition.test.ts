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
const wouldDispatch = (): StageResult => ({ kind: 'github', outcome: 'shadow', wouldDispatch: { flow: 'flows/ci.flow.ts', input: { base: 'origin/main', github: true }, headSha: sha, dispatched: false }, now: t });
const autoConfig = { ...config, mergePolicy: { ...config.mergePolicy, mode: 'auto' as const } };
const autoStart = (over: Parameters<typeof start>[0] = {}) => start({ config: autoConfig, ...over });
const plan = squashPlan({ base: 'main', baseSha: 'b'.repeat(40), headSha: sha, tree: 't'.repeat(40), subjects: ['feat: x'], sessionId: 's-1', runId: 'run-1', squashAuthor: 'session-human', fixRounds: 0, harness: 'claude' });

/** Feed one gate (A-adversarial, A-context, B) with the given adversarial ids. */
const gate = (s: LandState, ids: string[], now = t): LandState =>
  nextLandStage(nextLandStage(nextLandStage(s, review('adversarial', ids, now)), review('context', [], now)), ci([], now));

test('clean run: A-adversarial → A-context → B → D → E (would dispatch) → F → landed', () => {
  const cursors: Array<string | null> = [];
  let s = start();
  for (const r of [review('adversarial'), review('context'), ci(), rebase('unchanged'), wouldDispatch(), { kind: 'merge', outcome: 'planned', plan, now: t } as StageResult]) {
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
  assert.deepEqual(JSON.parse(completionDetail(s)), { land: 'next', runId: 'run-1', stage: 'C-1', seq: 3 });
  assert.deepEqual(JSON.parse(completionDetail(s, true)), { land: 'next', runId: 'run-1', stage: 'C-1', seq: 3, noop: true });
});

test('auto E: pending keeps the cursor at E, green moves to F, red feeds the fix loop', () => {
  const atE = nextLandStage(gate(autoStart(), []), rebase('unchanged'));
  const pending = nextLandStage(atE, { kind: 'github', outcome: 'pending', now: t });
  assert.equal(pending.cursor, 'E');
  assert.equal(pending.history.length, atE.history.length, 'pending does not close a gate');
  const green = nextLandStage(pending, { kind: 'github', outcome: 'green', now: t });
  assert.equal(green.cursor, 'F');

  const red = nextLandStage(pending, { kind: 'github', outcome: 'red', findings: [{ id: 'github:Desktop CI', source: 'github', severity: 'blocker', file: '', title: 'GitHub Desktop CI: failure' }], now: t });
  assert.equal(red.cursor, 'C-1');
  assert.deepEqual(red.findings.map(x => x.id), ['github:Desktop CI']);
  assert.deepEqual(red.history.at(-1), ['github:Desktop CI'], 'a red gate closes a gate like B does');
});

test('auto E: a red gate still escalates on round cap', () => {
  const capped = autoStart({ config: { ...autoConfig, fixLoop: { ...autoConfig.fixLoop, maxRounds: 1 } } });
  let s = nextLandStage(gate(capped, ['a']), fixed('c'.repeat(40)));
  s = gate(s, []);
  s = nextLandStage(s, rebase('unchanged'));
  s = nextLandStage(s, { kind: 'github', outcome: 'red', findings: [{ id: 'github:ci', source: 'github', severity: 'blocker', file: '', title: 'red' }], now: t });
  assert.equal(s.terminal?.state, 'needs_human');
  assert.equal(s.escalation?.reason, 'round_cap');
});

test('auto F: pushed lands with the commit; moved and non_ff go back to D', () => {
  const atF = nextLandStage(nextLandStage(gate(autoStart(), []), rebase('unchanged')), { kind: 'github', outcome: 'green', now: t });
  const landed = nextLandStage(atF, { kind: 'merge', outcome: 'pushed', plan, commit: 'd'.repeat(40), now: t });
  assert.equal(landed.terminal?.state, 'landed');
  assert.equal(landed.squashPlan?.pushed, true);
  assert.equal(landed.squashPlan?.commit, 'd'.repeat(40));
  assert.match(landed.terminal!.detail, /^landed AgentWorkforce\/relay-desktop@ddddddd on main after 0 fix round\(s\)$/);

  for (const outcome of ['moved', 'non_ff'] as const) {
    const s = nextLandStage(atF, { kind: 'merge', outcome, now: t });
    assert.equal(s.cursor, 'D', outcome);
    assert.equal(s.terminal, null);
  }
});

test('mode discipline: shadow outcomes refuse auto and vice versa', () => {
  const shadowE = nextLandStage(gate(start(), []), rebase('unchanged'));
  assert.throws(() => nextLandStage(shadowE, { kind: 'github', outcome: 'green', now: t }), /cannot take a green outcome under shadow/);
  const autoE = nextLandStage(gate(autoStart(), []), rebase('unchanged'));
  assert.throws(() => nextLandStage(autoE, wouldDispatch()), /cannot take a shadow outcome under auto/);
  const shadowF = nextLandStage(shadowE, wouldDispatch());
  assert.throws(() => nextLandStage(shadowF, { kind: 'merge', outcome: 'pushed', plan, commit: 'd'.repeat(40), now: t }), /cannot take a pushed outcome under shadow/);
});
