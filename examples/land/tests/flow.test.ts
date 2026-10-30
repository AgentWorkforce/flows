import assert from 'node:assert/strict';
import test from 'node:test';
import type { Ctx, AgentOptions } from '@relayflows/surface';
import { land, type LandInput } from '../land.flow.ts';

const sha = 'a'.repeat(40);
const root = '/runs/run-1/repo';
const stateDir = '/runs/run-1/state';
const intentFile = '/runs/run-1/intent/intent.md';
const input: LandInput = { repo: 'AgentWorkforce/relay-desktop', sha, sessionId: 'a71ff4c9-365f-4602-8e5a-06db39621973', intentFile, stateDir, runUrl: 'https://agentrelay.com/cloud/runs/run-1' };
const config = { reviewFlows: { adversarial: 'flows/adversarial-review.flow.ts', context: 'flows/context-review.flow.ts' }, ciFlow: 'flows/ci.flow.ts' };
type Raw = { severity: string; file: string; line?: number; title: string };
const blocker = (file: string, title: string): Raw => ({ severity: 'blocker', file, line: 1, title });

function fake(over: {
  config?: unknown; head?: string; adversarial?: Raw[][]; context?: Raw[][]; ciRed?: number[]; githubRed?: number;
  roundFiles?: string[][]; baseShas?: string[]; rebaseFails?: boolean; changelog?: [string, string];
} = {}) {
  const commands: string[] = [];
  const launches: string[] = [];
  const agents: Array<{ name: string; options: AgentOptions }> = [];
  const writes = new Map<string, string>();
  const done: Array<{ reason: string; detail?: string }> = [];
  let tick = 0, fetches = 0, githubRuns = 0;
  const record = (ok: boolean, output = '') => ({ ok, exitCode: ok ? 0 : 1, output, stdout: output, stderr: '' });
  const f = {
    run: async (command: string, options?: { onNonZero?: string }) => {
      commands.push(command);
      if (command === 'git rev-parse --show-toplevel') return root;
      if (command === 'git rev-parse HEAD') return over.head ?? sha;
      if (command === 'git rev-parse HEAD^{tree}') return 't'.repeat(40);
      if (command === 'git status --porcelain') return '';
      if (command === 'uname -sm') return 'Linux x86_64';
      if (command === 'node -p Date.now()') return String(tick += 60_000);
      if (command.startsWith('git show ') && command.includes('land.config.json')) return JSON.stringify(over.config ?? config);
      if (command.startsWith('git show ') && command.includes('CHANGELOG.md')) return command.includes('merge-base') ? over.changelog?.[0] ?? '' : over.changelog?.[1] ?? '';
      if (command.startsWith('git fetch')) return (over.baseShas ?? ['b'.repeat(40)])[Math.min(fetches++, (over.baseShas?.length ?? 1) - 1)]!;
      if (command.startsWith('git diff --name-only "$(git merge-base')) return 'probe/src/relay/agents.rs\nCHANGELOG.md';
      if (command.startsWith('git diff --name-only ')) return (over.roundFiles ?? [])[agents.length - 1]?.join('\n') ?? 'probe/src/relay/agents.rs';
      if (command.startsWith('git log --reverse')) return 'feat: upload policy gates relay auto-activation\nfix: review findings';
      if (command.includes(' rebase --quiet ')) return record(!over.rebaseFails, over.rebaseFails ? 'CONFLICT (content)' : '');
      if (command === 'git rebase --abort') return '';
      if (command.startsWith('mkdir -p ') && command.includes('nohup')) { launches.push(command); return 'started'; }
      if (command.startsWith('mkdir -p ')) return '';
      if (command.startsWith('for i in $(seq')) {
        const [, kind, n, lane] = /\/rounds\/(gate|github)-(\d+)\/?(\w*)\/?exit/.exec(command)!;
        if (kind === 'github') return String(githubRuns++ < (over.githubRed ?? 0) ? 1 : 0);
        return String(lane === 'ci' && over.ciRed?.includes(Number(n)) ? 1 : 0);
      }
      if (command.startsWith('tail -c')) return 'log tail';
      if (command.startsWith('if [ -f ')) {
        const [, n, lane] = /\/rounds\/gate-(\d+)\/(adversarial|context)\.report\.json/.exec(command)!;
        const list = (lane === 'adversarial' ? over.adversarial : over.context) ?? [];
        return JSON.stringify({ findings: list[Number(n)] ?? [] });
      }
      if (command.startsWith('command -v')) return '';
      if (command.startsWith('git -c user.name=relay-land') && command.includes(' add -A')) return '';
      if (command.startsWith('printf %s ')) {
        const [, b64, path] = /^printf %s '([^']*)' \| base64 -d > '([^']*)'$/.exec(command)!;
        writes.set(path!, Buffer.from(b64!, 'base64').toString('utf8'));
        return '';
      }
      if (options?.onNonZero === 'record') return record(true);
      throw new Error(`unexpected command: ${command}`);
    },
    agent: async (name: string, options: AgentOptions) => {
      agents.push({ name, options });
      return { completionReason: 'success', summary: '{}', artifacts: [] };
    },
    done: (reason: string, options?: { detail?: string }) => { done.push({ reason, detail: options?.detail }); },
  } as unknown as Ctx;
  const report = () => JSON.parse(writes.get(`${stateDir}/land-report.json`) ?? 'null');
  return { f, commands, launches, agents, writes, done, report };
}

const neverPushes = (commands: string[]) => {
  for (const c of commands) assert.doesNotMatch(c, /git push|gh pr |gh api .*merge|git merge /, c);
};

test('clean shadow run: plans the squash commit, never pushes, keeps every byte under stateDir', async () => {
  const x = fake();
  await land(x.f, input);
  assert.equal(x.done.length, 1);
  assert.equal(x.done[0]!.reason, 'success');
  assert.match(x.done[0]!.detail!, /^shadow: would land AgentWorkforce\/relay-desktop@aaaaaaa on main after 0 fix round\(s\); not pushed/);
  const plan = x.report().squashPlan;
  assert.equal(plan.pushed, false);
  assert.match(plan.message, /Relay-Session: a71ff4c9-365f-4602-8e5a-06db39621973\nLand-Run: state$/);
  assert.equal(x.report().landRef, 'land/{user}/aaaaaaa');
  assert.ok(x.report().stages.some((s: string) => /github gate: skipped in shadow/.test(s)));
  neverPushes(x.commands);
  assert.equal(x.launches.length, 3);
  assert.ok(x.launches.every(c => !c.includes('"github":true')));
  for (const path of x.writes.keys()) assert.ok(path.startsWith(`${stateDir}/`), path);
  for (const launch of x.launches) {
    assert.match(launch, /RELAYFLOW_STATE_DIR='\\''\/runs\/run-1\/state\/flows'\\''/);
    assert.match(launch, /--data-dir '\\''\/runs\/run-1\/state\/relayflowd\//);
    assert.ok(!launch.includes(root), 'nothing is written inside the checkout');
  }
});

test('intent isolation: only context review is given intentFile; the adversarial fleet never sees it', async () => {
  const x = fake();
  await land(x.f, input);
  const adversarial = x.launches.filter(c => c.includes('adversarial-review.flow.ts'));
  const context = x.launches.filter(c => c.includes('context-review.flow.ts'));
  const ci = x.launches.filter(c => c.includes('ci.flow.ts'));
  assert.equal(adversarial.length, 1);
  assert.ok(adversarial.every(c => !c.includes('intent')), adversarial[0]);
  assert.ok(ci.every(c => !c.includes('intent')));
  assert.ok(context.every(c => c.includes(`"intentFile":"${intentFile}"`)));
});

test('fix loop: a blocker is fixed in one round, then the gates rerun clean', async () => {
  const x = fake({ adversarial: [[blocker('probe/src/relay/agents.rs', 'race on upload flag')], []] });
  await land(x.f, input);
  assert.equal(x.done[0]!.reason, 'success');
  assert.deepEqual(x.agents.map(a => a.name), ['fix-r1']);
  assert.equal(x.agents[0]!.options.cli, 'claude');
  assert.equal(x.agents[0]!.options.model, undefined);
  assert.match(x.agents[0]!.options.task, /race on upload flag/);
  assert.match(x.agents[0]!.options.task, new RegExp(intentFile));
  assert.equal(x.launches.length, 6);
  assert.match(x.done[0]!.detail!, /after 1 fix round/);
  neverPushes(x.commands);
});

test('non-convergence: a finding surviving 2 rounds escalates with a ≤150-byte ask', async () => {
  const stuck = blocker('probe/src/relay/agents.rs', 'race on upload flag');
  const x = fake({ adversarial: [[stuck], [{ ...stuck, title: 'race on upload flag (raised before)' }], [stuck]] });
  await land(x.f, input);
  assert.equal(x.done[0]!.reason, 'needs_human');
  const message = x.done[0]!.detail!;
  assert.equal(message, 'Land AgentWorkforce/relay-desktop@aaaaaaa stuck: 1 blockers after 2 rounds. Fix or abort? https://agentrelay.com/cloud/runs/run-1');
  assert.ok(Buffer.byteLength(message) <= 150);
  assert.equal(x.report().escalation.reason, 'stuck_finding');
  assert.equal(x.agents.length, 2);
});

test('non-convergence: the round cap stops the loop', async () => {
  const x = fake({ config: { ...config, fixLoop: { maxRounds: 1 } }, ciRed: [0, 1] });
  await land(x.f, input);
  assert.equal(x.done[0]!.reason, 'needs_human');
  assert.equal(x.report().escalation.reason, 'round_cap');
  assert.equal(x.agents.length, 1);
});

test('formatter guard: a fix round touching files outside change ∪ findings escalates', async () => {
  const x = fake({ adversarial: [[blocker('probe/src/relay/agents.rs', 'bug')], []], roundFiles: [['probe/src/relay/agents.rs', 'probe/src/a.rs', 'probe/src/b.rs']] });
  await land(x.f, input);
  assert.equal(x.done[0]!.reason, 'needs_human');
  assert.match(x.done[0]!.detail!, /2 file\(s\) outside change ∪ findings \(looks like crate-wide cargo fmt churn\)/);
  assert.equal(x.launches.length, 3, 'no gates rerun after a guard breach');
});

test('changelog: required with no new Unreleased bullet becomes a finding for the fix loop', async () => {
  const x = fake({ config: { ...config, changelog: 'required' }, changelog: ['## Unreleased\n', '## Unreleased\n'] });
  await land(x.f, input);
  assert.equal(x.agents[0]?.name, 'fix-r1');
  assert.match(x.agents[0]!.options.task, /no new bullet under ## Unreleased/);
});

test('stage D: a moved base rebases and reruns the gates; a conflict escalates', async () => {
  const moved = fake({ baseShas: ['b'.repeat(40), 'c'.repeat(40)] });
  await land(moved.f, input);
  assert.equal(moved.done[0]!.reason, 'success');
  assert.equal(moved.launches.length, 6);
  assert.ok(moved.commands.some(c => c.includes(`rebase --quiet '${'c'.repeat(40)}'`)));
  assert.equal(moved.report().squashPlan.baseSha, 'c'.repeat(40));

  const conflict = fake({ baseShas: ['b'.repeat(40), 'c'.repeat(40)], rebaseFails: true });
  await land(conflict.f, input);
  assert.equal(conflict.done[0]!.reason, 'needs_human');
  assert.ok(conflict.commands.includes('git rebase --abort'));
  assert.equal(conflict.report().escalation.reason, 'rebase_conflict');
});

test('stage E: opted in for shadow, a red GitHub gate sends the run back to the fix loop', async () => {
  const x = fake({ config: { ...config, mergePolicy: { githubGateInShadow: true } }, githubRed: 1 });
  await land(x.f, input);
  assert.equal(x.done[0]!.reason, 'success');
  assert.equal(x.launches.filter(c => c.includes('"github":true')).length, 2);
  assert.deepEqual(x.agents.map(a => a.name), ['fix-r1']);
  assert.match(x.agents[0]!.options.task, /GitHub CI red/);
  neverPushes(x.commands);
});

test('refusals before any review: non-shadow mode, state inside the checkout, unpinned head', async () => {
  const approval = fake({ config: { ...config, mergePolicy: { mode: 'approval' } } });
  await land(approval.f, input);
  assert.equal(approval.done[0]!.reason, 'declined');
  assert.match(approval.done[0]!.detail!, /only shadow runs/);

  const inside = fake();
  await land(inside.f, { ...input, stateDir: `${root}/.relayflow` });
  assert.equal(inside.done[0]!.reason, 'needs_human');
  assert.match(inside.done[0]!.detail!, /stateDir must be outside the checkout/);

  const intentInside = fake();
  await land(intentInside.f, { ...input, intentFile: `${root}/intent.md` });
  assert.match(intentInside.done[0]!.detail!, /intentFile must be outside the checkout/);

  const moved = fake({ head: 'f'.repeat(40) });
  await land(moved.f, input);
  assert.match(moved.done[0]!.detail!, /not the pinned/);

  const baseMismatch = fake();
  await land(baseMismatch.f, { ...input, baseBranch: 'develop' });
  assert.match(baseMismatch.done[0]!.detail!, /disagrees with land.config/);

  const badSha = fake();
  await land(badSha.f, { ...input, sha: 'HEAD' });
  assert.match(badSha.done[0]!.detail!, /sha must match/);

  for (const x of [approval, inside, intentInside, moved, baseMismatch, badSha]) assert.equal(x.launches.length, 0);
});
