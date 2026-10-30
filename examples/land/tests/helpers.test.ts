import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideConvergence, escalationMessage, ESCALATION_MAX_BYTES, findingId, blockingFindings,
  formatterGuard, unreleasedBulletAdded, isInside, squashPlan, expandHome,
} from '../land.flow.ts';

const decide = (history: string[][], over: Partial<Parameters<typeof decideConvergence>[0]> = {}) =>
  decideConvergence({ history, roundsDone: history.length - 1, maxRounds: 4, elapsedMs: 0, budgetMs: 180 * 60_000, ...over });

test('convergence: a clean gate proceeds, even past the budget or cap', () => {
  assert.deepEqual(decide([['a'], []]), { action: 'proceed' });
  assert.deepEqual(decide([[]], { elapsedMs: 1e9, roundsDone: 9 }), { action: 'proceed' });
});

test('convergence: findings with rounds and budget left ask for a fix', () => {
  assert.deepEqual(decide([['a', 'b']]), { action: 'fix' });
  assert.deepEqual(decide([['a', 'b'], ['c']]), { action: 'fix' });
  // Ids churn and the count falls: still converging.
  assert.deepEqual(decide([['a', 'b', 'c'], ['b', 'd'], ['e']]), { action: 'fix' });
});

test('convergence: round cap', () => {
  const d = decide([['a'], ['b'], ['c'], ['d'], ['e']], { roundsDone: 4 });
  assert.equal(d.action, 'escalate');
  assert.equal(d.action === 'escalate' && d.reason, 'round_cap');
});

test('convergence: the same finding id surviving 2 consecutive rounds', () => {
  const d = decide([['a', 'x', 'y'], ['a', 'z'], ['a']]);
  assert.equal(d.action === 'escalate' && d.reason, 'stuck_finding');
  assert.match(d.action === 'escalate' ? d.detail : '', /a$/);
  // Survived only one round: not yet stuck.
  assert.deepEqual(decide([['x', 'y', 'z'], ['a', 'q'], ['a']]), { action: 'fix' });
  // Present, gone, back: not consecutive.
  assert.deepEqual(decide([['a', 'b', 'c'], ['b2'], ['a']]), { action: 'fix' });
});

test('convergence: finding count not decreasing for 2 rounds', () => {
  const d = decide([['a', 'b'], ['c', 'd'], ['e', 'f', 'g']]);
  assert.equal(d.action === 'escalate' && d.reason, 'not_decreasing');
  assert.match(d.action === 'escalate' ? d.detail : '', /2 -> 2 -> 3/);
  // One flat round is tolerated.
  assert.deepEqual(decide([['a', 'b'], ['c', 'd'], ['e']]), { action: 'fix' });
});

test('convergence: budget wins over every other rule', () => {
  const d = decide([['a'], ['a'], ['a']], { elapsedMs: 180 * 60_000, roundsDone: 4 });
  assert.equal(d.action === 'escalate' && d.reason, 'budget');
});

test('convergence: refuses an empty history', () => {
  assert.throws(() => decide([]), /at least one gate/);
});

const url = 'https://agentrelay.com/cloud/runs/0f9c2d4e-1b2a-4c3d-9e8f-123456789abc';
const sha = 'abcdef0123456789abcdef0123456789abcdef01';

test('escalation: exact template when it fits', () => {
  const short = 'https://agentrelay.com/r/run-1';
  const m = escalationMessage({ repo: 'AgentWorkforce/relay-desktop', sha, blockers: 2, rounds: 4, runUrl: short });
  assert.equal(m, `Land AgentWorkforce/relay-desktop@abcdef0 stuck: 2 blockers after 4 rounds. Fix or abort? ${short}`);
  assert.ok(Buffer.byteLength(m) <= ESCALATION_MAX_BYTES);
});

test('escalation: a realistic UUID run URL drops the repo owner first', () => {
  const m = escalationMessage({ repo: 'AgentWorkforce/relay-desktop', sha, blockers: 2, rounds: 4, runUrl: url });
  assert.equal(m, `Land relay-desktop@abcdef0 stuck: 2 blockers after 4 rounds. Fix or abort? ${url}`);
  assert.ok(Buffer.byteLength(m) <= ESCALATION_MAX_BYTES, `${Buffer.byteLength(m)} bytes`);
});

test('escalation: over 150 bytes truncates the summary, keeps the ask and URL intact', () => {
  const longUrl = `${url}?v=1`;
  const m = escalationMessage({ repo: 'AgentWorkforce/a-very-long-repository-name-that-goes-on', sha, blockers: 12, rounds: 4, runUrl: longUrl });
  assert.ok(Buffer.byteLength(m, 'utf8') <= ESCALATION_MAX_BYTES, `${Buffer.byteLength(m)} bytes`);
  assert.ok(m.endsWith(` Fix or abort? ${longUrl}`));
  assert.match(m, /^Land a-very-[a-z-]*…@abcdef0 stuck: 12 blockers after 4 rounds\./);
});

test('escalation: counts bytes, not code points, and never splits a character', () => {
  const m = escalationMessage({ repo: 'ü'.repeat(60), sha, blockers: 1, rounds: 2, runUrl: url });
  assert.ok(Buffer.byteLength(m, 'utf8') <= ESCALATION_MAX_BYTES);
  assert.ok(!m.includes('�'));
  assert.ok(m.endsWith(url));
});

test('escalation: a URL that cannot fit is refused, never cut', () => {
  assert.throws(() => escalationMessage({ repo: 'a/b', sha, blockers: 1, rounds: 1, runUrl: `https://x.test/${'y'.repeat(140)}` }), /runUrl too long/);
});

test('formatter guard: allows change files and finding files', () => {
  assert.deepEqual(formatterGuard({ roundFiles: ['a.rs', 'docs/x.md'], changeFiles: ['a.rs'], findingFiles: ['docs/x.md'] }), { ok: true, outside: [], detail: '' });
  assert.equal(formatterGuard({ roundFiles: [], changeFiles: [], findingFiles: [] }).ok, true);
});

test('formatter guard: rejects files outside change ∪ findings and flags cargo fmt churn', () => {
  const g = formatterGuard({ roundFiles: ['a.rs', 'b.rs', 'c.rs', 'b.rs'], changeFiles: ['a.rs'], findingFiles: [] });
  assert.equal(g.ok, false);
  assert.deepEqual(g.outside, ['b.rs', 'c.rs']);
  assert.match(g.detail, /cargo fmt/);
  const other = formatterGuard({ roundFiles: ['package.json'], changeFiles: ['a.rs'], findingFiles: [] });
  assert.equal(other.ok, false);
  assert.doesNotMatch(other.detail, /cargo fmt/);
});

test('finding ids survive line moves and the verifier\'s "raised before" marker', () => {
  assert.equal(findingId('adversarial', 'a.rs', 'Off-by-one in loop'), findingId('adversarial', 'a.rs', 'Off-by-one in loop (raised before)'));
  assert.notEqual(findingId('adversarial', 'a.rs', 'x'), findingId('context', 'a.rs', 'x'));
  const found = blockingFindings({ findings: [
    { severity: 'blocker', file: 'a.rs', line: 3, title: 'T' }, { severity: 'minor', file: 'b.rs', line: 1, title: 'M' },
    { severity: 'major', file: 'c.rs', title: 'U' },
  ] }, 'adversarial');
  assert.deepEqual(found.map(x => [x.severity, x.file, x.line]), [['blocker', 'a.rs', 3], ['major', 'c.rs', undefined]]);
  assert.throws(() => blockingFindings({}, 'context'), /no findings array/);
});

test('changelog: requires a new bullet under ## Unreleased', () => {
  const before = '# Changelog\n\n## Unreleased\n\n- old\n\n## 1.0.0\n\n- shipped\n';
  assert.equal(unreleasedBulletAdded(before, before.replace('- old', '- old\n- new thing')), true);
  assert.equal(unreleasedBulletAdded(before, before), false);
  assert.equal(unreleasedBulletAdded(before, before.replace('- shipped', '- shipped\n- wrong section')), false);
  assert.equal(unreleasedBulletAdded('', '## Unreleased\n\n* first\n'), true);
  assert.equal(unreleasedBulletAdded('', 'no heading\n- x\n'), false);
});

test('isInside', () => {
  assert.equal(isInside('/runs/1/repo/x', '/runs/1/repo'), true);
  assert.equal(isInside('/runs/1/repo', '/runs/1/repo/'), true);
  assert.equal(isInside('/runs/1/repo2', '/runs/1/repo'), false);
  assert.equal(isInside('/runs/1', '/runs/1/repo'), false);
});

test('squash plan carries the trailers and is never marked pushed', () => {
  const plan = squashPlan({ base: 'main', baseSha: 'b'.repeat(40), headSha: sha, tree: 't'.repeat(40), subjects: ['feat: x', 'fix: y'], sessionId: 's-1', runId: 'run-1', squashAuthor: 'session-human', fixRounds: 1, harness: 'claude' });
  assert.equal(plan.message, 'feat: x\n\n- fix: y\n\nRelay-Session: s-1\nLand-Run: run-1');
  assert.equal(plan.pushed, false);
  assert.match(plan.author, /PLACEHOLDER pending decision \(cloud#5806 Q3\)/);
  assert.deepEqual(plan.coAuthors, ['<session agent>', '<fix agent: claude>']);
});

test('expandHome: only the literal $HOME/ prefix, against an absolute HOME', () => {
  assert.equal(expandHome('$HOME/land-runs/lr_1', '/home/agent'), '/home/agent/land-runs/lr_1');
  assert.equal(expandHome('$HOME/land-runs/lr_1', '/home/agent/'), '/home/agent/land-runs/lr_1');
  assert.equal(expandHome('/runs/lr_1', undefined), '/runs/lr_1', 'absolute paths pass through without HOME');
  for (const home of [undefined, '', 'home/agent', '/', '/../root', '/home/../x', '/home/./x', '/home/a b']) {
    assert.throws(() => expandHome('$HOME/x', home), /HOME must be set to an absolute path/, String(home));
  }
});
