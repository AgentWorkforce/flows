import assert from 'node:assert/strict';
import test from 'node:test';
import type { Ctx, AgentOptions } from '@relayflows/surface';
import { land, type LandInput } from '../land.flow.ts';

const sha = 'a'.repeat(40);
const root = '/runs/run-1/repo';
const stateDir = '/runs/run-1';
const stateFile = `${stateDir}/land-state.json`;
const intentFile = '/runs/intent/run-1/intent.md';
const base: Omit<LandInput, 'stage'> = { repo: 'AgentWorkforce/relay-desktop', sha, sessionId: 'a71ff4c9-365f-4602-8e5a-06db39621973', intentFile, stateDir, runUrl: 'https://agentrelay.com/cloud/runs/run-1' };
const config = { reviewFlows: { adversarial: 'flows/adversarial-review.flow.ts', context: 'flows/context-review.flow.ts' }, ciFlow: 'flows/ci.flow.ts' };
type Raw = { severity: string; file: string; line?: number; title: string };
const blocker = (file: string, title: string): Raw => ({ severity: 'blocker', file, line: 1, title });

/**
 * One persistent sandbox world (stateDir survives between hosted runs; the
 * checkout is a fresh clone each run). Each `invoke` is one hosted stage run.
 */
function world(over: {
  config?: unknown; head?: string; adversarial?: Raw[][]; context?: Raw[][]; ciRed?: number[]; githubRed?: number;
  roundFiles?: string[][]; baseShas?: string[]; rebaseFails?: boolean; changelog?: [string, string]; refSha?: string;
} = {}) {
  const files = new Map<string, string>();
  const commands: string[][] = [];
  const launches: string[] = [];
  const agents: Array<{ name: string; options: AgentOptions }> = [];
  const done: Array<{ reason: string; detail: Record<string, unknown> }> = [];
  let tick = 0, gate = 0, githubRuns = 0, headCounter = 0, fetches = 0;
  const record = (ok: boolean, output = '') => ({ ok, exitCode: ok ? 0 : 1, output, stdout: output, stderr: '' });

  const invoke = async (stage: string, input: Partial<LandInput> = {}) => {
    const ran: string[] = [];
    commands.push(ran);
    let head = over.head ?? sha; // fresh clone at the pinned sha
    let baseRef = '';
    const f = {
      run: async (command: string, options?: { onNonZero?: string }) => {
        ran.push(command);
        if (command === 'git rev-parse --show-toplevel') return root;
        if (command === 'git rev-parse HEAD') return head;
        if (command === 'git rev-parse HEAD^{tree}') return 't'.repeat(40);
        if (command === "git rev-parse 'origin/main'") return baseRef;
        if (command === 'git status --porcelain') return '';
        if (command === 'uname -sm') return 'Linux x86_64';
        if (command === 'node -p Date.now()') return String(tick += 60_000);
        if (command.startsWith('cat ') && command.includes('land-state.json')) return files.get(stateFile) ?? 'null';
        if (command.startsWith('git show ') && command.includes('land.config.json')) return JSON.stringify(over.config ?? config);
        if (command.startsWith('git show ') && command.includes('CHANGELOG.md')) return command.includes('merge-base') ? over.changelog?.[0] ?? '' : over.changelog?.[1] ?? '';
        if (command.startsWith('git fetch --no-tags --quiet origin')) { const list = over.baseShas ?? ['b'.repeat(40)]; baseRef = list[Math.min(fetches++, list.length - 1)]!; return ''; }
        if (command.startsWith('git ls-remote')) return over.refSha ?? sha;
        if (command.startsWith('git fetch --quiet ') && command.includes('land.bundle')) { head = files.get(`${stateDir}/land.bundle`)!; return head; }
        if (command.startsWith('git bundle create')) { files.set(`${stateDir}/land.bundle`, head); return ''; }
        if (command.startsWith('git diff --name-only "$(git merge-base')) return 'probe/src/relay/agents.rs\nCHANGELOG.md';
        if (command.startsWith('git diff --name-only ')) return (over.roundFiles ?? [])[agents.length - 1]?.join('\n') ?? 'probe/src/relay/agents.rs';
        if (command.startsWith('git log --reverse')) return 'feat: upload policy gates relay auto-activation\nfix: review findings';
        if (command.includes(' rebase --quiet ')) { if (!over.rebaseFails) head = `r${'0'.repeat(38)}${++headCounter}`.slice(-40); return record(!over.rebaseFails, over.rebaseFails ? 'CONFLICT (content)' : ''); }
        if (command === 'git rebase --abort') return '';
        if (command.startsWith('mkdir -p ') && command.includes('nohup')) { launches.push(command); return 'started'; }
        if (command.startsWith('mkdir -p ')) return '';
        if (command.startsWith('for i in $(seq')) {
          if (command.includes('/github/exit')) return String(githubRuns++ < (over.githubRed ?? 0) ? 1 : 0);
          return String(command.includes('/ci/exit') && over.ciRed?.includes(gate - 1) ? 1 : 0);
        }
        if (command.startsWith('tail -c')) return 'log tail';
        if (command.startsWith('if [ -f ')) {
          const lane = command.includes('adversarial-review/report.json') ? 'adversarial' : 'context';
          if (lane === 'adversarial') gate++;
          const list = (lane === 'adversarial' ? over.adversarial : over.context) ?? [];
          return JSON.stringify({ findings: list[gate - 1] ?? [] });
        }
        if (command.startsWith('command -v')) return '';
        if (command.startsWith('git -c user.name=relay-land') && command.includes(' add -A')) { head = `c${'0'.repeat(38)}${++headCounter}`.slice(-40); return ''; }
        if (command.startsWith('printf %s ')) {
          const [, b64, path] = /^printf %s '([^']*)' \| base64 -d > '([^']*)\.tmp' && mv /.exec(command)!;
          files.set(path!, Buffer.from(b64!, 'base64').toString('utf8'));
          return '';
        }
        if (options?.onNonZero === 'record') return record(true);
        throw new Error(`unexpected command: ${command}`);
      },
      agent: async (name: string, options: AgentOptions) => {
        agents.push({ name, options });
        return { completionReason: 'success', summary: '{}', artifacts: [] };
      },
      done: (reason: string, options?: { detail?: string }) => { done.push({ reason, detail: JSON.parse(options?.detail ?? '{}') }); },
    } as unknown as Ctx;
    await land(f, { ...base, stage, ...input } as LandInput);
    return done.at(-1)!;
  };

  /** What Cloud's queue does: chain hosted runs from each completion detail until a terminal state. */
  const drive = async (input: Partial<LandInput> = {}) => {
    const stages: string[] = [];
    let stage = 'A-adversarial';
    for (let i = 0; i < 40; i++) {
      stages.push(stage);
      const result = await invoke(stage, input);
      if (result.detail.land !== 'next') return { stages, result };
      stage = result.detail.stage as string;
    }
    throw new Error('did not terminate');
  };
  const state = () => JSON.parse(files.get(stateFile) ?? 'null');
  return { invoke, drive, state, files, commands, launches, agents, done };
}

const neverPushes = (commands: string[][]) => {
  for (const c of commands.flat()) assert.doesNotMatch(c, /git push|gh pr |gh api .*merge|git merge /, c);
};

test('clean shadow run: one hosted run per stage, E skipped, squash plan written, never pushed', async () => {
  const w = world();
  const { stages, result } = await w.drive();
  assert.deepEqual(stages, ['A-adversarial', 'A-context', 'B', 'D', 'F']);
  assert.equal(result.reason, 'success');
  assert.equal(result.detail.land, 'terminal');
  assert.equal(result.detail.state, 'landed');
  assert.match(result.detail.detail as string, /^shadow: would land AgentWorkforce\/relay-desktop@aaaaaaa on main after 0 fix round\(s\); not pushed/);
  const s = w.state();
  assert.equal(s.version, 1);
  assert.equal(s.squashPlan.pushed, false);
  assert.match(s.squashPlan.message, /Relay-Session: a71ff4c9-365f-4602-8e5a-06db39621973\nLand-Run: run-1$/);
  assert.ok(s.log.includes('E: skipped in shadow mode'));
  assert.equal(w.launches.length, 3, 'one repo flow per stage A-adversarial, A-context, B');
  assert.ok(w.launches.every(c => !c.includes('"github":true')));
  neverPushes(w.commands);
  for (const path of w.files.keys()) assert.ok(path.startsWith(`${stateDir}/`), path);
  for (const launch of w.launches) {
    assert.match(launch, /RELAYFLOW_STATE_DIR='\\''\/runs\/run-1\/flows'\\''/);
    assert.match(launch, /--data-dir '\\''\/runs\/run-1\/relayflowd\//);
    assert.ok(!launch.includes(root), 'nothing is written inside the checkout');
  }
});

test('intent isolation: only context review is given intentFile; the adversarial fleet never sees it', async () => {
  const w = world();
  await w.drive();
  const adversarial = w.launches.filter(c => c.includes('adversarial-review.flow.ts'));
  const context = w.launches.filter(c => c.includes('context-review.flow.ts'));
  const ci = w.launches.filter(c => c.includes('ci.flow.ts'));
  assert.equal(adversarial.length, 1);
  assert.ok(adversarial.every(c => !c.includes('intent')), adversarial[0]);
  assert.ok(ci.every(c => !c.includes('intent')));
  assert.ok(context.length === 1 && context.every(c => c.includes(`"intentFile":"${intentFile}"`)));
  // Each stage run launches exactly one repo flow.
  assert.deepEqual(w.commands.map(run => run.filter(c => c.includes('nohup')).length), [1, 1, 1, 0, 0]);
});

test('fix loop: the fixup head is carried between runs in land.bundle, then the gate reruns clean', async () => {
  const w = world({ adversarial: [[blocker('probe/src/relay/agents.rs', 'race on upload flag')], []] });
  const { stages, result } = await w.drive();
  assert.deepEqual(stages, ['A-adversarial', 'A-context', 'B', 'C-1', 'A-adversarial', 'A-context', 'B', 'D', 'F']);
  assert.equal(result.detail.state, 'landed');
  assert.deepEqual(w.agents.map(a => a.name), ['fix-r1']);
  assert.match(w.agents[0]!.options.task, /race on upload flag/);
  assert.match(w.agents[0]!.options.task, new RegExp(intentFile));
  const s = w.state();
  assert.notEqual(s.headSha, sha);
  assert.equal(s.pinnedSha, sha);
  assert.equal(w.files.get(`${stateDir}/land.bundle`), s.headSha);
  // Every run after C-1 restores the fixup head from the bundle before working.
  for (const run of w.commands.slice(4)) assert.ok(run.some(c => c.includes('land.bundle') && c.startsWith('git fetch')), 'restored');
  neverPushes(w.commands);
});

test('non-convergence: a finding surviving 2 rounds ends needs_human with a ≤150-byte ask', async () => {
  const stuck = blocker('probe/src/relay/agents.rs', 'race on upload flag');
  const w = world({ adversarial: [[stuck], [{ ...stuck, title: 'race on upload flag (raised before)' }], [stuck]] });
  const { result } = await w.drive();
  assert.equal(result.reason, 'needs_human');
  assert.equal(result.detail.state, 'needs_human');
  assert.equal(result.detail.detail, 'Land AgentWorkforce/relay-desktop@aaaaaaa stuck: 1 blockers after 2 rounds. Fix or abort? https://agentrelay.com/cloud/runs/run-1');
  assert.ok(Buffer.byteLength(result.detail.detail as string) <= 150);
  assert.equal(w.state().escalation.reason, 'stuck_finding');
  assert.equal(w.agents.length, 2);
});

test('formatter guard: a fix round touching files outside change ∪ findings ends needs_human', async () => {
  const w = world({ adversarial: [[blocker('probe/src/relay/agents.rs', 'bug')], []], roundFiles: [['probe/src/relay/agents.rs', 'probe/src/a.rs', 'probe/src/b.rs']] });
  const { stages, result } = await w.drive();
  assert.equal(stages.at(-1), 'C-1');
  assert.equal(result.reason, 'needs_human');
  assert.match(result.detail.detail as string, /2 file\(s\) outside change ∪ findings \(looks like crate-wide cargo fmt churn\)/);
});

test('changelog required with no new Unreleased bullet becomes a finding for the fix loop', async () => {
  const w = world({ config: { ...config, changelog: 'required', fixLoop: { maxRounds: 1 } }, changelog: ['## Unreleased\n', '## Unreleased\n'] });
  await w.drive();
  assert.equal(w.agents[0]?.name, 'fix-r1');
  assert.match(w.agents[0]!.options.task, /no new bullet under ## Unreleased/);
  assert.equal(w.state().escalation.reason, 'round_cap');
});

test('stage D: a moved base rebases and regates; a conflict ends needs_human', async () => {
  const moved = world({ baseShas: ['b'.repeat(40), 'b'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)] });
  const run = await moved.drive();
  assert.deepEqual(run.stages, ['A-adversarial', 'A-context', 'B', 'D', 'A-adversarial', 'A-context', 'B', 'D', 'F']);
  assert.equal(moved.state().baseSha, 'c'.repeat(40));
  assert.equal(moved.state().squashPlan.baseSha, 'c'.repeat(40));

  const conflict = world({ baseShas: ['b'.repeat(40), 'b'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)], rebaseFails: true });
  const { result } = await conflict.drive();
  assert.equal(result.reason, 'needs_human');
  assert.ok(conflict.commands.flat().includes('git rebase --abort'));
  assert.equal(conflict.state().escalation.reason, 'rebase_conflict');
});

test('superseded: the land ref moved → cancelled before any work in that run', async () => {
  const w = world({ refSha: 'f'.repeat(40) });
  const { stages, result } = await w.drive({ ref: 'land/khaliq/aaaaaaa' });
  assert.deepEqual(stages, ['A-adversarial']);
  assert.equal(result.reason, 'canceled');
  assert.equal(result.detail.state, 'cancelled');
  assert.equal(w.launches.length, 0);
  assert.equal(w.state().terminal.state, 'cancelled');
});

test('idempotent cursor: a retried stage whose state write landed is a no-op; a reaped one reruns', async () => {
  const w = world();
  assert.deepEqual((await w.invoke('A-adversarial')).detail, { land: 'next', stage: 'A-context', seq: 1 });
  // Cloud retries the same stage after the state was written: nothing runs.
  const launches = w.launches.length;
  assert.deepEqual((await w.invoke('A-adversarial')).detail, { land: 'next', stage: 'A-context', seq: 1, noop: true });
  assert.equal(w.launches.length, launches);
  // A run reaped before its state write: the stage reruns from the same state.
  const saved = w.files.get(stateFile)!;
  await w.invoke('A-context');
  w.files.set(stateFile, saved);
  assert.deepEqual((await w.invoke('A-context')).detail, { land: 'next', stage: 'B', seq: 2 });
  // A stage that is not the cursor never runs.
  assert.deepEqual((await w.invoke('F')).detail, { land: 'next', stage: 'B', seq: 2, noop: true });
  // A terminal run reports its terminal state again.
  for (const stage of ['B', 'D', 'F']) await w.invoke(stage);
  const again = await w.invoke('F');
  assert.equal(again.detail.state, 'landed');
  assert.equal(again.detail.seq, 5);
});

test('stage E: opted in for shadow, a red GitHub gate sends the run back to the fix loop', async () => {
  const w = world({ config: { ...config, mergePolicy: { githubGateInShadow: true } }, githubRed: 1 });
  const { stages, result } = await w.drive();
  assert.deepEqual(stages, ['A-adversarial', 'A-context', 'B', 'D', 'E', 'C-1', 'A-adversarial', 'A-context', 'B', 'D', 'E', 'F']);
  assert.equal(result.detail.state, 'landed');
  assert.match(w.agents[0]!.options.task, /GitHub CI red/);
  neverPushes(w.commands);
});

test('refusals: no state outside A-adversarial, non-shadow mode, state or intent inside the checkout, wrong run', async () => {
  const cases: Array<[Partial<LandInput> & { stage: string }, RegExp, ReturnType<typeof world>?]> = [
    [{ stage: 'B' }, /a run starts at A-adversarial/],
    [{ stage: 'A-adversarial', stateDir: `${root}/.relayflow` }, /stateDir must be outside the checkout/],
    [{ stage: 'A-adversarial', intentFile: `${root}/intent.md` }, /intentFile must be outside the checkout/],
    [{ stage: 'A-adversarial', baseBranch: 'develop' }, /disagrees with land.config/],
    [{ stage: 'A-adversarial', sha: 'HEAD' }, /sha must match/],
    [{ stage: 'Z' }, /stage must match/],
  ];
  for (const [input, message] of cases) {
    const w = world();
    const { stage, ...rest } = input;
    const result = await w.invoke(stage, rest);
    assert.equal(result.reason, 'needs_human');
    assert.equal(result.detail.land, 'refused');
    assert.match(result.detail.detail as string, message);
    assert.equal(w.launches.length, 0);
    assert.equal(w.state(), null, 'a refused invocation writes no state');
  }
  const approval = world({ config: { ...config, mergePolicy: { mode: 'approval' } } });
  const declined = await approval.invoke('A-adversarial');
  assert.equal(declined.reason, 'declined');
  assert.match(declined.detail.detail as string, /only shadow runs/);
  assert.equal(approval.state(), null);

  const other = world();
  await other.invoke('A-adversarial');
  const wrong = await other.invoke('A-context', { sessionId: 'someone-else' });
  assert.match(wrong.detail.detail as string, /land-state.json belongs to/);
  assert.equal(other.state().cursor, 'A-context', 'a wrong invocation does not poison the state');
});
