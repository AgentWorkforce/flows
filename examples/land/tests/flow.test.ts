import assert from 'node:assert/strict';
import test from 'node:test';
import type { Ctx, AgentOptions } from '@relayflows/surface';
import { land, UNSHALLOW_IF_SHALLOW, type LandInput } from '../land.flow.ts';

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
const snapshotSha = '9'.repeat(40);
const mergedCommit = 'e'.repeat(40);

function world(over: {
  config?: unknown; head?: string; adversarial?: Raw[][]; context?: Raw[][]; ciRed?: number[];
  roundFiles?: string[][]; baseShas?: string[]; rebaseFails?: boolean; changelog?: [string, string]; refSha?: string;
  home?: string; dir?: string;
  agentClis?: readonly string[];
  flowsVersion?: string;
  /** Auto mode: the dispatched repo gate's exit per dispatch attempt; 'pending' when it overruns. */
  githubExit?: Array<number | 'pending'>; ghRuns?: GhRun[]; ghRunsSeq?: GhRun[][];
  pushFails?: 'non_ff' | 'other'; landedCommit?: string; headContainsBase?: boolean; fAncestorFails?: boolean; ciFetchFails?: boolean; pushDryRunFails?: boolean; codexLoginFails?: boolean; adversarialExit?: number; contextExit?: number; reviewTail?: string;
} = {}) {
  const dir = over.dir ?? stateDir;
  const files = new Map<string, string>();
  const commands: string[][] = [];
  const launches: string[] = [];
  const agents: Array<{ name: string; options: AgentOptions }> = [];
  const done: Array<{ reason: string; detail: Record<string, unknown> }> = [];
  let tick = 0, gate = 0, headCounter = 0, fetches = 0;
  const record = (ok: boolean, output = '') => ({ ok, exitCode: ok ? 0 : 1, output, stdout: output, stderr: '' });
  // A head submitted without the base permanently contains it after one rebase.
  let rebasedOnce = false;

  const invoke = async (stage: string, input: Partial<LandInput> = {}) => {
    const ran: string[] = [];
    commands.push(ran);
    let head = over.head ?? sha; // fresh clone at the pinned sha
    let baseRef = '';
    const f = {
      ...(over.agentClis === undefined ? {} : { capabilities: { agentClis: over.agentClis } }),
      run: async (command: string, options?: { onNonZero?: string }) => {
        ran.push(command);
        if (command.endsWith(' --version')) return record(true, over.flowsVersion ?? '2.0.57');
        if (command === 'git rev-parse --show-toplevel') return root;
        if (command === 'git rev-parse HEAD') return head;
        if (command === 'git rev-parse HEAD^{tree}') return 't'.repeat(40);
        if (command === "git rev-parse 'origin/main'") return baseRef;
        if (command === 'git status --porcelain') return '';
        if (command === 'uname -sm') return 'Linux x86_64';
        if (command === 'node -p "Date.now()"') return String(tick += 60_000);
        if (command === `printf '%s' "\${HOME:-}"`) return over.home ?? '';
        if (command.startsWith('cat ')) return files.get(/^cat '([^']*)'/.exec(command)![1]!) ?? 'null';
        if (command.startsWith('git show ') && command.includes('land.config.json')) return JSON.stringify(over.config ?? config);
        if (command.startsWith('git show ') && command.includes('CHANGELOG.md')) return command.includes('merge-base') ? over.changelog?.[0] ?? '' : over.changelog?.[1] ?? '';
        if (command.startsWith(`git fetch --no-tags --quiet ${UNSHALLOW_IF_SHALLOW} origin `)) { const list = over.baseShas ?? ['b'.repeat(40)]; baseRef = list[Math.min(fetches++, list.length - 1)]!; return ''; }
        if (command.startsWith('git ls-remote')) return over.refSha ?? sha;
        if (command.startsWith('git fetch --quiet ') && command.includes('land.bundle')) { head = files.get(/'([^']*land\.bundle)'/.exec(command)![1]!)!; return head; }
        if (command.startsWith('git bundle create')) { files.set(/'([^']*land\.bundle)\.tmp'/.exec(command)![1]!, head); return ''; }
        if (command.startsWith('git diff --name-only "$(git merge-base')) return 'probe/src/relay/agents.rs\nCHANGELOG.md';
        if (command.startsWith('git diff --name-only ')) return (over.roundFiles ?? [])[agents.length - 1]?.join('\n') ?? 'probe/src/relay/agents.rs';
        if (command.startsWith('git log --reverse')) return 'feat: upload policy gates relay auto-activation\nfix: review findings';
        if (command.startsWith('git merge-base --is-ancestor')) {
          // F asks about HEAD; D asks about the recorded head sha. A rebase makes the head contain the base.
          if (command.endsWith(' HEAD')) return record(!over.fAncestorFails);
          return record(rebasedOnce || over.headContainsBase !== false);
        }
        if (command.includes(' rebase --quiet ')) { if (!over.rebaseFails) { rebasedOnce = true; } if (!over.rebaseFails) head = `r${'0'.repeat(38)}${++headCounter}`.slice(-40); return record(!over.rebaseFails, over.rebaseFails ? 'CONFLICT (content)' : ''); }
        if (command === 'git rebase --abort') return '';
        if (command.startsWith('mkdir -p ') && command.includes('nohup')) { launches.push(command); return 'started'; }
        if (command.startsWith('mkdir -p ')) return '';
        if (command.startsWith('for i in $(seq')) {
          if (command.includes('/github/exit')) {
            const attempt = launches.filter(c => c.includes('"github":true')).length - 1;
            const list = over.githubExit ?? ['pending'];
            return String(list[Math.min(attempt, list.length - 1)]);
          }
          if (command.includes('gh run list')) {
            const attempt = launches.filter(c => c.includes('"github":true')).length - 1;
            const seq = over.ghRunsSeq?.[Math.min(attempt, (over.ghRunsSeq.length ?? 1) - 1)];
            let runs = seq ?? over.ghRuns ?? [{ databaseId: 1, workflowName: 'Desktop CI', status: 'completed', conclusion: 'success', createdAt: '2999-01-01T00:00:00Z' }];
            const since = /'(\d{4}-\d{2}-\d{2}T[^']+Z)'/.exec(command)?.[1];
            if (since) runs = runs.filter(x => x.createdAt >= since);
            if (!runs.length || runs.some(x => x.status !== 'completed')) return 'pending';
            return JSON.stringify(runs);
          }
          if (command.includes('/adversarial/exit')) return String(over.adversarialExit ?? 0);
          if (command.includes('/context/exit')) return String(over.contextExit ?? 0);
          return String(command.includes('/ci/exit') && over.ciRed?.includes(gate - 1) ? 1 : 0);
        }
        if (command.startsWith('git fetch --quiet origin ') && command.includes('refs/heads/ci/*')) return record(over.ciFetchFails !== true, over.ciFetchFails ? 'fetch failed' : '');
        if (command.startsWith('git log --format=%H --grep')) return over.landedCommit ?? '';
        if (command.startsWith('git push --dry-run')) return record(over.pushDryRunFails !== true, over.pushDryRunFails ? 'denied' : '');
        if (command.startsWith('codex login status')) return record(!over.codexLoginFails);
        if (command.startsWith('for sha in $(git for-each-ref')) return snapshotSha;
        if (command.startsWith('gh run list')) return JSON.stringify(over.ghRuns ?? []);
        if (command.startsWith('git push --quiet origin --delete')) return record(true);
        if (command.includes(' commit-tree ')) return mergedCommit;
        if (command.startsWith('git push origin ') && command.includes(':refs/heads/')) {
          if (over.pushFails === 'non_ff') return record(false, '! [rejected] main -> main (non-fast-forward)');
          if (over.pushFails === 'other') return record(false, 'error: GH006: protected branch update failed');
          return record(true);
        }
        if (command.startsWith('tail -c')) {
          if (command.includes('/adversarial/') || command.includes('/context/')) return over.reviewTail ?? 'log tail';
          return 'log tail';
        }
        if (command.startsWith('if [ -f ')) {
          const lane = command.includes('adversarial-review/report.json') ? 'adversarial' : 'context';
          if (lane === 'adversarial') gate++;
          const list = (lane === 'adversarial' ? over.adversarial : over.context) ?? [];
          return JSON.stringify({ findings: list[gate - 1] ?? [] });
        }
        if (command === 'command -v gh >/dev/null && gh auth status') return record(true);

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
  const state = () => JSON.parse(files.get(`${dir}/land-state.json`) ?? 'null');
  return { invoke, drive, state, files, commands, launches, agents, done };
}

const neverPushes = (commands: string[][]) => {
  for (const c of commands.flat()) assert.doesNotMatch(c, /git push|gh pr |gh api .*merge|git merge /, c);
};

test('clean shadow run: one hosted run per stage, E would dispatch, squash plan written, never pushed', async () => {
  const w = world();
  const { stages, result } = await w.drive();
  assert.deepEqual(stages, ['A-adversarial', 'A-context', 'B', 'D', 'E', 'F']);
  assert.equal(result.reason, 'success');
  assert.equal(result.detail.land, 'terminal');
  assert.equal(result.detail.state, 'landed');
  assert.match(result.detail.detail as string, /^shadow: would land AgentWorkforce\/relay-desktop@aaaaaaa on main after 0 fix round\(s\); not pushed/);
  const s = w.state();
  assert.equal(s.version, 1);
  assert.equal(s.squashPlan.pushed, false);
  assert.match(s.squashPlan.message, /Relay-Session: a71ff4c9-365f-4602-8e5a-06db39621973\nLand-Run: run-1$/);
  assert.ok(s.log.includes('E: shadow: would dispatch flows/ci.flow.ts {"github":true} at aaaaaaa'));
  assert.equal(s.githubGate.dispatched, false);
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
  assert.deepEqual(w.commands.map(run => run.filter(c => c.includes('nohup')).length), [1, 1, 1, 0, 0, 0]);
});

test('fix loop: the fixup head is carried between runs in land.bundle, then the gate reruns clean', async () => {
  const w = world({ adversarial: [[blocker('probe/src/relay/agents.rs', 'race on upload flag')], []] });
  const { stages, result } = await w.drive();
  assert.deepEqual(stages, ['A-adversarial', 'A-context', 'B', 'C-1', 'A-adversarial', 'A-context', 'B', 'D', 'E', 'F']);
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
  assert.deepEqual(run.stages, ['A-adversarial', 'A-context', 'B', 'D', 'A-adversarial', 'A-context', 'B', 'D', 'E', 'F']);
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
  assert.deepEqual((await w.invoke('A-adversarial')).detail, { land: 'next', runId: 'run-1', stage: 'A-context', seq: 1 });
  // Cloud retries the same stage after the state was written: nothing runs.
  const launches = w.launches.length;
  assert.deepEqual((await w.invoke('A-adversarial')).detail, { land: 'next', runId: 'run-1', stage: 'A-context', seq: 1, noop: true });
  assert.equal(w.launches.length, launches);
  // A run reaped before its state write: the stage reruns from the same state.
  const saved = w.files.get(stateFile)!;
  await w.invoke('A-context');
  w.files.set(stateFile, saved);
  assert.deepEqual((await w.invoke('A-context')).detail, { land: 'next', runId: 'run-1', stage: 'B', seq: 2 });
  // A stage that is not the cursor never runs.
  assert.deepEqual((await w.invoke('F')).detail, { land: 'next', runId: 'run-1', stage: 'B', seq: 2, noop: true });
  // A terminal run reports its terminal state again.
  for (const stage of ['B', 'D', 'E', 'F']) await w.invoke(stage);
  const again = await w.invoke('F');
  assert.equal(again.detail.state, 'landed');
  assert.equal(again.detail.seq, 6);
});

test('stage E in shadow: records what it would dispatch, launches nothing, moves on to F', async () => {
  const w = world();
  await w.drive();
  const e = w.commands[4]!;
  assert.ok(e.every(c => !c.includes('nohup') && !c.includes('"github":true')), 'E dispatches nothing');
  assert.ok(w.launches.every(c => !c.includes('"github":true')));
  assert.deepEqual(w.state().githubGate, { flow: 'flows/ci.flow.ts', input: { base: 'origin/main', github: true }, headSha: sha, dispatched: false });
  neverPushes(w.commands);
});

test('the removed githubGateInShadow flag is refused as an unknown key, before any work', async () => {
  const w = world({ config: { ...config, mergePolicy: { githubGateInShadow: true } } });
  const result = await w.invoke('A-adversarial');
  assert.equal(result.reason, 'needs_human');
  assert.match(result.detail.detail as string, /\.mergePolicy\.githubGateInShadow: unknown key/);
  assert.equal(w.launches.length, 0);
  assert.equal(w.state(), null);
});

test('refusals: no state outside A-adversarial, approval mode, state or intent inside the checkout, wrong run', async () => {
  const cases: Array<[Partial<LandInput> & { stage: string }, RegExp, ReturnType<typeof world>?]> = [
    [{ stage: 'B' }, /a run starts at A-adversarial/],
    [{ stage: 'A-adversarial', stateDir: `${root}/.relayflow`, runId: 'run-1' }, /stateDir must be outside the checkout/],
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
  assert.match(declined.detail.detail as string, /is not implemented; shadow and auto run/);
  assert.equal(approval.state(), null);

  const other = world();
  await other.invoke('A-adversarial');
  const wrong = await other.invoke('A-context', { sessionId: 'someone-else' });
  assert.match(wrong.detail.detail as string, /land-state.json belongs to/);
  assert.equal(other.state().cursor, 'A-context', 'a wrong invocation does not poison the state');
});

test('runId: an explicit Cloud id names the Land-Run trailer and every completion detail, not the stateDir path', async () => {
  const runId = 'lr_0123456789abcdef0123456789abcdef';
  const w = world();
  const { result } = await w.drive({ runId });
  assert.equal(result.detail.state, 'landed');
  assert.equal(result.detail.runId, runId);
  for (const done of w.done) assert.equal(done.detail.runId, runId);
  assert.equal(w.state().runId, runId);
  assert.match(w.state().squashPlan.message, new RegExp(`\\nLand-Run: ${runId}$`));
  assert.doesNotMatch(w.state().squashPlan.message, /Land-Run: run-1/);
});

test('runId: absent, it falls back to the stateDir segment for local use', async () => {
  const w = world();
  await w.drive();
  assert.equal(w.state().runId, 'run-1');
  assert.match(w.state().squashPlan.message, /\nLand-Run: run-1$/);
});

test('runId: a malformed id, or a stateDir segment that is not one, is refused before any work', async () => {
  for (const [input, message] of [
    [{ runId: 'lr_bad id' }, /runId must match/],
    [{ runId: '-lr' }, /runId must match/],
    [{ runId: 'x'.repeat(129) }, /runId must match/],
    [{ stateDir: '/runs/run.1' }, /runId \(from the stateDir segment; pass runId\) must match/],
  ] as const) {
    const w = world();
    const result = await w.invoke('A-adversarial', input);
    assert.equal(result.detail.land, 'refused');
    assert.match(result.detail.detail as string, message);
    assert.equal(w.launches.length, 0);
    assert.equal(w.state(), null);
  }
});

test('runId: a stage invoked with another run id is refused and leaves the state alone', async () => {
  const w = world();
  await w.invoke('A-adversarial', { runId: 'lr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  const wrong = await w.invoke('A-context', { runId: 'lr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
  assert.equal(wrong.detail.land, 'refused');
  assert.match(wrong.detail.detail as string, /belongs to run lr_a{32}/);
  assert.equal(w.state().cursor, 'A-context');
  assert.equal(w.state().seq, 1);
});

const HOME = '/home/agent';
const homeInput = { stateDir: '$HOME/land-runs/run-1', intentFile: '$HOME/land-runs/run-1/intent/intent.md' };

test('$HOME paths: expanded from the run\'s own HOME, read once per run through a journaled step', async () => {
  const dir = `${HOME}/land-runs/run-1`;
  const w = world({ home: HOME, dir });
  const { stages, result } = await w.drive(homeInput);
  assert.deepEqual(stages, ['A-adversarial', 'A-context', 'B', 'D', 'E', 'F']);
  assert.equal(result.detail.state, 'landed');
  assert.equal(w.state().runId, 'run-1');
  for (const path of w.files.keys()) assert.ok(path.startsWith(`${dir}/`), path);
  for (const run of w.commands) assert.equal(run.filter(c => c.includes('${HOME')).length, 1, 'HOME read exactly once per stage run');
  for (const c of w.commands.flat()) assert.ok(!c.includes('$HOME/'), `unexpanded: ${c}`);
  const context = w.launches.find(c => c.includes('context-review.flow.ts'))!;
  assert.ok(context.includes(`"intentFile":"${dir}/intent/intent.md"`));
  assert.ok(w.launches.find(c => c.includes('adversarial-review.flow.ts'))!.includes(`RELAYFLOW_STATE_DIR='\\''${dir}/flows'\\''`));
  assert.ok(w.launches.every(c => c.includes(`--data-dir '\\''${dir}/relayflowd/`)));
  assert.ok(!w.launches.find(c => c.includes('adversarial-review.flow.ts'))!.includes('intent'));
});

test('$HOME paths: a trailing slash on HOME is normalized', async () => {
  const w = world({ home: `${HOME}/`, dir: `${HOME}/land-runs/run-1` });
  assert.equal((await w.invoke('A-adversarial', homeInput)).detail.stage, 'A-context');
  assert.ok(w.state());
});

test('$HOME paths: absolute paths never read HOME', async () => {
  const w = world({ home: HOME });
  await w.drive();
  assert.ok(w.commands.flat().every(c => !c.includes('${HOME')));
});

test('$HOME paths: refused when HOME is unset, relative, or unsafe', async () => {
  for (const [home, message] of [
    ['', /HOME must be set to an absolute path to expand \$HOME\/land-runs\/run-1; got ""/],
    ['home/agent', /HOME must be set to an absolute path/],
    ['/', /HOME must be set to an absolute path/],
    ['/home/../root', /HOME must be set to an absolute path/],
    ['/../root', /HOME must be set to an absolute path/],
    ['/home/a b', /HOME must be set to an absolute path/],
  ] as const) {
    const w = world({ home });
    const result = await w.invoke('A-adversarial', homeInput);
    assert.equal(result.detail.land, 'refused', home);
    assert.match(result.detail.detail as string, message);
    assert.equal(w.launches.length, 0);
    assert.equal(w.files.size, 0, 'nothing written');
  }
});

test('$HOME paths: only the exact $HOME/ prefix; no other variable, form or .. segment', async () => {
  for (const stateDir of ['$USER/land-runs/run-1', '${HOME}/land-runs/run-1', '$HOMEDIR/run-1', '~/land-runs/run-1',
    '$HOME/../etc/run-1', '$HOME/land-runs/./run-1', '$HOME/a/$HOME/run-1', '$HOME', 'land-runs/run-1', '/runs/$HOME/run-1']) {
    const w = world({ home: HOME });
    const result = await w.invoke('A-adversarial', { ...homeInput, stateDir, runId: 'run-1' });
    assert.equal(result.detail.land, 'refused', stateDir);
    assert.match(result.detail.detail as string, /stateDir must match/, stateDir);
    assert.ok(w.commands.flat().every(c => !c.includes('${HOME')), 'refused before HOME is read');
  }
  const intent = world({ home: HOME });
  const bad = await intent.invoke('A-adversarial', { ...homeInput, intentFile: '$PWD/intent.md' });
  assert.match(bad.detail.detail as string, /intentFile must match/);
});

test('$HOME paths: the outside-checkout check runs on the expanded path', async () => {
  const w = world({ home: '/runs/run-1/repo' });
  const result = await w.invoke('A-adversarial', homeInput);
  assert.equal(result.detail.land, 'refused');
  assert.match(result.detail.detail as string, /stateDir must be outside the checkout \/runs\/run-1\/repo/);
  const intent = world({ home: '/runs/run-1/repo' });
  const r2 = await intent.invoke('A-adversarial', { stateDir, intentFile: '$HOME/intent.md' });
  assert.match(r2.detail.detail as string, /intentFile must be outside the checkout/);
});

test('absolute paths: a . or .. in any segment is refused, including the first (/../x)', async () => {
  for (const stateDir of ['/../etc/run-1', '/runs/../etc/run-1', '/./runs/run-1', '/runs/run-1/..']) {
    const w = world();
    const result = await w.invoke('A-adversarial', { stateDir, runId: 'run-1' });
    assert.equal(result.detail.land, 'refused', stateDir);
    assert.match(result.detail.detail as string, /stateDir must match/, stateDir);
  }
  const w = world();
  assert.match((await w.invoke('A-adversarial', { intentFile: '/../intent.md' })).detail.detail as string, /intentFile must match/);
});

test('the base fetch deepens a shallow checkout and names only the base refspec', async () => {
  // A deleted land ref must not fail the fetch before supersession: no bare
  // `git fetch origin`, and the unshallow rides on the explicit base refspec.
  assert.equal(UNSHALLOW_IF_SHALLOW, '$([ "$(git rev-parse --is-shallow-repository)" = true ] && echo --unshallow)');
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const sh = (cwd: string, script: string) => execFileSync('sh', ['-c', script], { cwd, encoding: 'utf8' }).trim();
  const root = mkdtempSync(join(tmpdir(), 'land-unshallow-'));
  sh(root, 'git init -q -b main src && cd src && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m a && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m b');
  sh(root, `git clone -q --depth 1 file://${root}/src shallow && git clone -q file://${root}/src full`);
  assert.equal(sh(join(root, 'shallow'), `echo ${UNSHALLOW_IF_SHALLOW}`), '--unshallow');
  assert.equal(sh(join(root, 'full'), `echo ${UNSHALLOW_IF_SHALLOW}`), '');
});

interface GhRun { databaseId: number; workflowName: string; status: string; conclusion: string | null; createdAt: string }
const autoConfig = { ...config, mergePolicy: { mode: 'auto' } };
const gh = (conclusion: string | null, status = 'completed', name = 'Desktop CI', createdAt = '2999-01-01T00:00:00Z'): GhRun =>
  ({ databaseId: 1, workflowName: name, status, conclusion, createdAt });

test('auto: dispatch overruns, the next E awaits the pushed snapshot, F squash-pushes and lands', async () => {
  const w = world({ config: autoConfig });
  const { stages, result } = await w.drive();
  assert.deepEqual(stages, ['A-adversarial', 'A-context', 'B', 'D', 'E', 'E', 'F']);
  assert.equal(result.reason, 'success');
  assert.equal(result.detail.state, 'landed');
  const dispatch = w.launches.find(c => c.includes('ci.flow.ts') && c.includes('"github":true'));
  assert.ok(dispatch, 'the repo gate really ran with {"github":true}');
  const book = JSON.parse(w.files.get(`${stateDir}/github-gate.json`)!);
  assert.equal(book.snapshotSha, snapshotSha);
  const s = w.state();
  assert.equal(s.squashPlan.pushed, true);
  assert.equal(s.squashPlan.commit, mergedCommit);
  const flat = w.commands.flat();
  const commitTree = flat.find(c => c.includes(' commit-tree '))!;
  assert.ok(commitTree.includes('Relay-Session: a71ff4c9-365f-4602-8e5a-06db39621973'), commitTree);
  assert.ok(commitTree.includes('Land-Run: run-1'), commitTree);
  assert.ok(flat.includes(`git push origin '${mergedCommit}:refs/heads/main'`), 'squash pushed to main');
  assert.ok(flat.includes(`git push --quiet origin --delete 'ci/${snapshotSha.slice(0, 12)}'`), 'snapshot branch deleted');
});

test('auto: a gate that finishes inside the dispatch window applies its verdict in the same run', async () => {
  const w = world({ config: autoConfig, githubExit: [0] });
  const { stages, result } = await w.drive();
  assert.deepEqual(stages, ['A-adversarial', 'A-context', 'B', 'D', 'E', 'F']);
  assert.equal(result.detail.state, 'landed');
  const book = JSON.parse(w.files.get(`${stateDir}/github-gate.json`)!);
  assert.equal(book.attempts, 1, 'the dispatch attempt was persisted before the wait');
  assert.equal(book.snapshotSha, undefined, 'no await bookkeeping for an in-window verdict');
});

test('auto: red GitHub gate goes to the next fix round', async () => {
  const w = world({ config: autoConfig, githubExit: [1, 0] });
  const { stages, result } = await w.drive();
  assert.ok(stages.includes('C-1'), stages.join(','));
  assert.equal(result.detail.state, 'landed');
  assert.equal(w.agents[0]?.name, 'fix-r1');
  assert.match(w.agents[0]!.options.task, /github gate ended red/);
});

test('auto: a failed dispatched run is red to the fix loop', async () => {
  const w = world({ config: autoConfig, ghRunsSeq: [[gh('failure')], [gh('success')]] });
  const { stages, result } = await w.drive();
  assert.ok(stages.includes('C-1'));
  assert.equal(result.detail.state, 'landed');
  assert.match(w.agents[0]!.options.task, /GitHub Desktop CI: failure/);
});

test('auto: still-pending dispatched runs keep E as the cursor across stage runs', async () => {
  const w = world({ config: autoConfig, ghRuns: [gh(null, 'in_progress')] });
  await w.invoke('A-adversarial'); await w.invoke('A-context'); await w.invoke('B'); await w.invoke('D');
  const first = await w.invoke('E');
  assert.equal(first.detail.stage, 'E');
  const second = await w.invoke('E');
  assert.equal(second.detail.stage, 'E');
  const book = JSON.parse(w.files.get(`${stateDir}/github-gate.json`)!);
  assert.equal(book.polls, 1);
});

test('auto: F goes back to D on non-fast-forward', async () => {
  const w = world({ config: autoConfig, pushFails: 'non_ff' });
  let last;
  for (const stage of ['A-adversarial', 'A-context', 'B', 'D', 'E', 'E', 'F']) last = await w.invoke(stage);
  assert.equal(last!.detail.stage, 'D');
});

test('auto: a moved base at F goes back to D and regates', async () => {
  const moved = world({ config: autoConfig, baseShas: ['b'.repeat(40), 'b'.repeat(40), 'b'.repeat(40), 'b'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)] });
  const { stages, result } = await moved.drive();
  assert.deepEqual(stages.slice(0, 8), ['A-adversarial', 'A-context', 'B', 'D', 'E', 'E', 'F', 'D']);
  assert.equal(result.detail.state, 'landed');
});

test('auto: a non-FF, non-permission push failure ends needs_human', async () => {
  const w = world({ config: autoConfig, pushFails: 'other' });
  const { result } = await w.drive();
  assert.equal(result.detail.state, 'needs_human');
  assert.match(result.detail.detail as string, /push to main failed/);
});

test('auto and shadow: the land harness is the review fleets\' clis and the fix agent\'s cli', async () => {
  for (const cfg of [autoConfig, config]) {
    const w = world({ config: cfg });
    await w.drive();
    const reviewLaunches = w.launches.filter(c => c.includes('-review.flow.ts'));
    assert.ok(reviewLaunches.length >= 2 && reviewLaunches.every(c => c.includes('"clis":["codex"]')), reviewLaunches[0]);
  }
});

test('auto: a stage reaped after the push records the landed commit instead of landing twice', async () => {
  // F's run-start fetch sees base moved to our own squash commit.
  const w = world({ config: autoConfig, baseShas: ['b'.repeat(40), 'b'.repeat(40), 'b'.repeat(40), 'b'.repeat(40), 'b'.repeat(40), mergedCommit], landedCommit: mergedCommit });
  let last;
  for (const stage of ['A-adversarial', 'A-context', 'B', 'D', 'E', 'E', 'F']) last = await w.invoke(stage);
  assert.equal(last!.detail.state, 'landed');
  assert.equal(last!.detail.commit, mergedCommit);
  assert.ok(!w.commands.at(-1)!.some(c => c.includes(' commit-tree ')), 'no second squash commit');
});

test('auto: F refuses to squash a head that never contained the base', async () => {
  const w = world({ config: autoConfig, fAncestorFails: true });
  let last;
  for (const stage of ['A-adversarial', 'A-context', 'B', 'D', 'E', 'E', 'F']) last = await w.invoke(stage);
  assert.equal(last!.detail.stage, 'D');
});

test('auto: D rebases a head that never contained an unmoved base, then lands', async () => {
  const w = world({ config: autoConfig, headContainsBase: false });
  const { stages, result } = await w.drive();
  assert.ok(stages.filter(x => x === 'D').length >= 2, stages.join(','));
  assert.equal(w.state().rebases, 1);
  assert.equal(result.detail.state, 'landed');
});

test('auto: three red GitHub gates escalate stuck_finding instead of alternating past the stall checks', async () => {
  const stuckConfig = { ...config, mergePolicy: { mode: 'auto' }, fixLoop: { maxRounds: 5 } };
  const w = world({ config: stuckConfig, ghRunsSeq: [[gh('failure')], [gh('failure')], [gh('failure')]] });
  const { stages, result } = await w.drive();
  assert.ok(stages.includes('C-1'));
  assert.equal(result.detail.state, 'needs_human');
  assert.equal(w.state().escalation.reason, 'stuck_finding');
});

test('auto: a run set still growing between polls stays pending; a stable set gives the verdict', async () => {
  const r1 = gh('success'), r2 = gh('success');
  r2.databaseId = 2;
  // First check sees {r1}, a later poll sees {r1,r2} — the growing set keeps
  // the gate pending until the set is stable across two consecutive checks.
  const w = world({ config: autoConfig });
  await w.invoke('A-adversarial'); await w.invoke('A-context'); await w.invoke('B'); await w.invoke('D');
  await w.invoke('E');
  (w as any).setRuns?.(1);
  // Drive awaits manually through the same invoke loop: poll1 writes {1,2},
  // poll2 sees a stable set → green.
  const w2 = world({ config: autoConfig, ghRunsSeq: [[r1, r2]] });
  await w2.invoke('A-adversarial'); await w2.invoke('A-context'); await w2.invoke('B'); await w2.invoke('D');
  await w2.invoke('E');
  const e2 = await w2.invoke('E');
  assert.equal(e2.detail.stage, 'F');
  const book = JSON.parse(w2.files.get(`${stateDir}/github-gate.json`)!);
  assert.deepEqual(book.seenRunIds, [1, 2]);
});

test('auto: a stale completed run older than the dispatch bound cannot produce a verdict', async () => {
  const stale = gh('success');
  stale.createdAt = '1960-01-01T00:00:00Z';
  const w = world({ config: autoConfig, ghRuns: [stale] });
  await w.invoke('A-adversarial'); await w.invoke('A-context'); await w.invoke('B'); await w.invoke('D');
  await w.invoke('E');
  const e = await w.invoke('E');
  assert.equal(e.detail.stage, 'E', 'the stale run is filtered by createdAt>=since; the gate stays pending');
});

test('auto and shadow: a non-default harness is the review fleets\' clis and the fix agent\'s cli', async () => {
  const claudeConfig = { ...config, fixLoop: { harness: 'claude' } };
  const w = world({ config: claudeConfig, ciRed: [0] });
  await w.drive();
  const reviewLaunches = w.launches.filter(c => c.includes('review'));
  assert.ok(reviewLaunches.every(c => c.includes('"clis":["claude"]')), reviewLaunches[0]);
  const fix = w.agents.find(a => a.name === 'fix-r1');
  assert.equal(fix?.options.cli, 'claude');
});

test('a harness without a worker adapter fails at stage one with a clear error', async () => {
  for (const harness of ['grok']) {
    const w = world({ config: { ...config, fixLoop: { harness } } });
    const { result } = await w.drive();
    assert.equal(result.reason, 'needs_human');
    assert.match(JSON.stringify(result.detail), /no worker adapter/);
  }
});

test('Devin refuses missing/older runtime metadata before review or fix work', async () => {
  for (const agentClis of [undefined, [], ['claude', 'codex']]) {
    const w = world({ config: { ...config, fixLoop: { harness: 'devin' } }, agentClis });
    const { result } = await w.drive();
    assert.equal(result.reason, 'needs_human');
    assert.match(JSON.stringify(result.detail), /requires a runtime advertising the native Devin adapter/);
    assert.equal(w.launches.length, 0);
    assert.equal(w.agents.length, 0);
  }
});

test('each supported fix harness launches with its literal pinned model', async () => {
  for (const [harness, model] of [['claude', 'claude-sonnet-5'], ['codex', 'gpt-5.6-sol'], ['devin', 'gpt-5.6-sol']] as const) {
    const w = world({ config: { ...config, fixLoop: { harness } }, agentClis: ['claude', 'codex', 'devin'],
      adversarial: [[blocker('src/fix.ts', 'fix this')], []] });
    await w.drive();
    assert.equal(w.agents.length, 1);
    assert.equal(w.agents[0]!.options.cli, harness);
    assert.equal(w.agents[0]!.options.model, model);
  }
});

test('Devin refuses an older or unknown child flows runtime before review work', async () => {
  for (const flowsVersion of ['2.0.56', '2.0.57-beta.1', '2.00.057', '2.0.057', '3.0.0', '', 'not a version']) {
    const w = world({ config: { ...config, fixLoop: { harness: 'devin' } }, agentClis: ['devin'], flowsVersion });
    const { result } = await w.drive();
    assert.equal(result.reason, 'needs_human');
    assert.match(JSON.stringify(result.detail), /flowsBin.*2.0.57/);
    assert.equal(w.launches.length, 0);
    assert.equal(w.agents.length, 0);
  }
});

test('a review lane that cannot launch its cli ends needs_human, not a fix round', async () => {
  const w = world({ adversarialExit: 1, reviewTail: 'REFUSED [invalid_spec] agent_cli_unresolved: codex login status exited non-zero' });
  const { result } = await w.drive();
  assert.equal(result.reason, 'needs_human');
  assert.match(JSON.stringify(result.detail), /could not launch its cli/);
  assert.equal(w.agents.length, 0, 'no fix round ran');
});

test('codex without a login in the stage sandbox ends needs_human at preflight', async () => {
  const w = world({ codexLoginFails: true });
  const { result } = await w.drive();
  assert.equal(result.reason, 'needs_human');
  const detail = JSON.stringify(result.detail);
  assert.match(detail, /not authenticated/);
  assert.match(detail, /FLOW_OPENAI_API_KEY/);
  assert.equal(w.launches.length, 0, 'stage one stopped: no review fleet ran');
  assert.equal(w.agents.length, 0, 'stage one stopped: no fix agent ran');
});

test('auto: a push-denied git credential fails preflight before any stage runs', async () => {
  const w = world({ config: autoConfig, pushDryRunFails: true });
  const { result } = await w.drive();
  assert.equal(result.reason, 'needs_human');
  assert.match(JSON.stringify(result.detail), /push-capable git credential/);
});
