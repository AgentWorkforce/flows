import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { compileYaml, toKernelSpec } from '../src/compile.js';
import { checkFlow } from '../src/cli/check.js';
import { JournalClient } from '../src/journal-client.js';
import type { StepDispatchEvent } from '../src/protocol.js';
import { AgentWorker } from '../src/worker.js';
import { resolveSpecCliPaths } from '../src/cli/hn-monitor.js';
import { emitDueTicks, type TickCursor } from '../src/tick-source.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SDK = join(ROOT, 'packages', 'sdk');
const BUILT_CLI = join(SDK, 'dist', 'cli.js');
const TESTDATA = join(ROOT, 'testdata');
// ops/cargo.sh builds into a target dir OUTSIDE the repo, because
// kernel/target/debug is ~4900 files and its presence in the propagated tree
// makes the sandbox's relayfile flush fail with HTTP 413 — non-fatally, so runs
// silently lose their work. Resolution has to follow the build, or these cases
// SKIP rather than fail and the suite reports a false green.
const TOOLCHAIN_TARGET =
  process.env['CARGO_TARGET_DIR'] ??
  join(process.env['RELAYFLOWS_TOOLCHAIN_HOME'] ?? join(homedir(), '.relayflows-toolchain'), 'target');
const RELAYFLOWD = resolve(process.env['RELAYFLOWD_BIN'] ?? locateRelayflowd());

/**
 * ops/cargo.sh builds into a target dir outside the repo, keyed per worktree so
 * concurrent worktrees do not share one target. Resolution has to find that
 * key without duplicating the hash, or these cases SKIP instead of failing and
 * the suite reports a false green — and worse, a stale binary left at an older
 * path gets exercised in place of the one just built.
 */
function locateRelayflowd(): string {
  const direct = join(TOOLCHAIN_TARGET, 'debug', 'relayflowd');
  if (existsSync(direct)) return direct;

  // One level down: $toolchain/target/<worktree-key>/debug/relayflowd. Pick the
  // most recently built, which is the one this checkout just produced.
  const keyed = existsSync(TOOLCHAIN_TARGET)
    ? readdirSync(TOOLCHAIN_TARGET)
        .map((entry) => join(TOOLCHAIN_TARGET, entry, 'debug', 'relayflowd'))
        .filter((candidate) => existsSync(candidate))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : [];
  if (keyed[0] !== undefined) return keyed[0];

  return join(ROOT, 'kernel', 'target', 'debug', 'relayflowd');
}
const temporaryDirectories: string[] = [];
const daemons: ChildProcess[] = [];
/** Detached daemons this suite did not spawn itself, reaped by pid. */
const daemonPids: number[] = [];
const clients: JournalClient[] = [];

beforeAll(() => {
  requireExecutable(RELAYFLOWD, 'RELAYFLOWD_BIN', '(cd kernel && ../ops/cargo.sh build)');
  requireExecutable(BUILT_CLI, 'built flows CLI', '(cd sdk && npm run build)');
  console.log(`LIVE_KERNEL relayflowd=${RELAYFLOWD}`);
  console.log(`LIVE_KERNEL flows=${BUILT_CLI}`);
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const daemon of daemons.splice(0)) await stopDaemon(daemon);
  for (const pid of daemonPids.splice(0)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('built flows CLI against live relayflowd', () => {
  it('runs rung (a), parks rung (b), and keeps JSON report-shaped', async () => {
    const dataDir = temporaryDirectory('flows-live-cli-');
    await startDaemon(dataDir);

    const deterministic = invokeCli([
      'run', '--data-dir', dataDir, join(TESTDATA, 'hello-deterministic.flow.yaml'),
    ]);
    expect(deterministic.status, deterministic.stderr).toBe(0);
    expect(deterministic.stdout).toMatch(/RUN [0-9A-Z]{26}/);
    expect(deterministic.stdout).toContain('completionReason: success');

    const parked = invokeCli([
      'run', '--data-dir', dataDir, join(TESTDATA, 'hello-llm.flow.yaml'),
    ]);
    expect(parked.status, parked.stderr).toBe(3);
    expect(parked.stderr).toContain('PARKED [run_parked]');
    expect(parked.stderr).toContain('step "answer" (llm)');
    expect(parked.stderr).toContain('no worker is attached');

    const agentParked = invokeCli([
      'run', '--data-dir', dataDir, join(TESTDATA, 'hello-agent.flow.yaml'),
    ]);
    expect(agentParked.status, agentParked.stderr).toBe(3);
    expect(agentParked.stderr).toContain('PARKED [run_parked]');
    expect(agentParked.stderr).toContain('step "edit" (agent)');

    const failedFlow = join(dataDir, 'failed.flow.yaml');
    writeFileSync(failedFlow, `
version: '0.1.0'
steps:
  - id: fail
    type: deterministic
    command: "exit 7"
`);
    const failed = invokeCli(['run', '--data-dir', dataDir, failedFlow]);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('FAILED [step_failed]');
    expect(failed.stdout).toContain('completionReason: step_failed');
    const failedRunId = failed.stdout.match(/RUN ([0-9A-Z]{26})/)?.[1];
    expect(failedRunId).toBeDefined();
    const failedClient = await connectClient(dataDir);
    const failedJournal = (await failedClient.journalRead(failedRunId!, 1)).entries;
    const terminal = failedJournal.find((entry) => journalType(entry) === 'run.completed');
    expect(terminal).toMatchObject({
      entry_type: 'run.completed',
      payload: { completionReason: 'step_failed', failed_step_id: 'fail' },
    });

    const json = invokeCli([
      'run', '--json', '--data-dir', dataDir, join(TESTDATA, 'hello-deterministic.flow.yaml'),
    ]);
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: true,
      command: 'run',
      status: 'completed',
      completionReason: 'success',
    });

    const invalid = invokeCli(['resume', '--json']);
    expect(invalid.status).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      ok: false,
      diagnostics: [{ kind: 'invalid_invocation' }],
    });

    const liveClient = await connectClient(dataDir);
    await expect(liveClient.runResume('absent-run')).rejects.toMatchObject({
      code: 'run_not_found',
    });
  }, 30_000);

  it('allows a deterministic run to exceed the bounded request timeout', async () => {
    const dataDir = temporaryDirectory('flows-live-long-run-');
    await startDaemon(dataDir);
    const flow = join(dataDir, 'long.flow.yaml');
    writeFileSync(flow, `
version: '0.1.0'
steps:
  - id: first
    type: deterministic
    command: sleep 16
  - id: second
    type: deterministic
    dependsOn: [first]
    command: sleep 16
`);

    const completed = invokeCli(['run', '--data-dir', dataDir, flow]);

    expect(completed.status, completed.stderr).toBe(0);
    expect(completed.stdout).toContain('completionReason: success');
  }, 45_000);

  it('follows a live worker dispatch through flows run', async () => {
    const dataDir = temporaryDirectory('flows-live-worker-');
    await startDaemon(dataDir);
    const worker = await connectClient(dataDir);
    await worker.hello('live-cli-worker');
    const dispatched = eventOnce<StepDispatchEvent>(worker, 'step.dispatch');
    await worker.workerAttach('live-cli-llm', ['llm']);

    const running = invokeCliAsync([
      'run', '--data-dir', dataDir, join(TESTDATA, 'hello-llm.flow.yaml'),
    ]);
    const lease = await dispatched;
    expect((await worker.runGet(lease.run_id)).steps[lease.step_id]).toEqual({
      type: 'llm',
      state: 'running',
      lease_deadline_ms: lease.lease_deadline_ms,
    });
    await worker.stepComplete(
      lease.run_id,
      lease.step_id,
      lease.attempt,
      lease.idempotency_key,
      'success',
      { output: { answer: 4 }, usage: { tokens_in: 2, tokens_out: 1, dollars: '0.001' } },
    );
    const completed = await running;

    expect(completed.status, completed.stderr).toBe(0);
    expect(completed.stdout).toContain('completionReason: success');
    expect(completed.stderr).not.toContain('protocol_error');
  });

  it('cancels over the real socket and rejects the lease holder after closure', async () => {
    const dataDir = temporaryDirectory('flows-live-cancel-');
    await startDaemon(dataDir);
    const worker = await connectClient(dataDir);
    await worker.hello('live-cancel-worker');
    const dispatched = eventOnce<StepDispatchEvent>(worker, 'step.dispatch');
    await worker.workerAttach('live-cancel-worker', ['llm']);
    const control = await connectClient(dataDir);
    await control.hello('live-cancel-control');
    const started = await control.runStart(toKernelSpec(compileYaml(`
version: '0.1.0'
steps:
  - id: model
    type: llm
    prompt: answer
`)));
    const lease = await dispatched;

    const canceled = await control.runCancel(started.run_id);
    expect(canceled).toMatchObject({
      run_id: started.run_id,
      status: 'failed',
      completion_reason: 'canceled',
    });
    await expect(control.runCancel(started.run_id)).resolves.toEqual(canceled);
    // Parallel dispatch (#137) admits every mutating verb through
    // `ensure_mutable` before the lease lookup, so an already-terminal run is
    // refused for terminality rather than for lease ownership. `lease_conflict`
    // would claim someone else holds this lease, which is false here: nobody
    // does, the run is over. The refusal itself, and the journal assertions
    // below, are unchanged.
    await expect(worker.stepComplete(
      lease.run_id,
      lease.step_id,
      lease.attempt,
      lease.idempotency_key,
      'success',
      { output: { answer: 4 } },
    )).rejects.toMatchObject({ code: 'run_terminal' });

    const entries = (await control.journalRead(started.run_id, 1)).entries as {
      entry_type: string;
      payload: { completionReason?: string };
    }[];
    expect(entries.filter((entry) => entry.entry_type === 'run.cancel.requested')).toHaveLength(1);
    expect(entries.filter((entry) => entry.entry_type === 'run.completed')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ completionReason: 'canceled' }) }),
    ]);
  });

  it('runs an agent CLI end to end through the SDK worker', async () => {
    const directory = temporaryDirectory('flows-live-agent-worker-');
    const dataDir = join(directory, 'data');
    const cli = join(directory, 'agent-cli');
    writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] !== '--relayflows-adapter-v1') process.exit(9);
process.stdout.write('relayflows-agent-cli-v1\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  if (input.trim() === '') process.exit(0);
  const request = JSON.parse(input);
  process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  process.stdout.write('handled: ' + request.instruction);
});
`);
    chmodSync(cli, 0o755);
    await startDaemon(dataDir);

    const client = await connectClient(dataDir);
    await client.hello('live-sdk-agent-worker');
    const worker = new AgentWorker(client, {
      workerId: 'live-sdk-agent-worker',
      pins: {
        workspace: [{ surface: 'repo', revision_id: 'rev-a' }],
        streams: [],
      },
    });
    await worker.attach();

    const started = await client.runStart(toKernelSpec(compileYaml(`
version: '0.1.0'
steps:
  - id: execute
    type: agent
    cli: ${JSON.stringify(cli)}
    instruction: Perform the declared work.
`)));

    expect(await waitForStep(client, started.run_id, 'execute', 'done')).toMatchObject({
      type: 'agent',
      state: 'done',
    });
    await worker.close();
  });

  it('can always get a parked run to a late-attaching worker', async () => {
    // The contract that cost the most time to establish, so it is pinned here.
    //
    // A run started with no worker parks with its step in `runnable`. Attaching
    // a worker afterwards does NOT re-drive it — `attach_worker`
    // (server/session.rs) registers the worker and nothing revisits parked
    // runs. That is deliberate, not a defect: the run is driven by whoever
    // started it, and `run.resume` is the primitive that picks it back up.
    //
    // This matters for gate 2. The HN demo submits events while nothing is
    // attached, so every woken run parks and stays parked — not because the
    // kernel cannot execute it, but because nothing resumes it. Either attach
    // the worker BEFORE submitting, or resume afterwards.
    const dataDir = temporaryDirectory('flows-live-resume-');
    await startDaemon(dataDir);
    // Start from a canonical spec rather than compiling yaml: this test is
    // about dispatch ordering, not about the authoring surface.
    const spec = JSON.parse(
      readFileSync(join(TESTDATA, 'hn-monitor.spec.canonical.json'), 'utf8'),
    ) as Parameters<JournalClient['runStart']>[0];

    const starter = await connectClient(dataDir);
    await starter.hello('live-resume-starter');
    const started = await starter.runStart(spec);
    const runId = started.run_id;
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const worker = await connectClient(dataDir);
    await worker.hello('live-resume-worker');
    const dispatched = eventOnce<StepDispatchEvent>(worker, 'step.dispatch');
    await worker.workerAttach('live-resume-agent', ['agent'], {
      workspace: [{ surface: 'repo', revision_id: 'rev-a' }],
      streams: [],
    });

    // Observation, deliberately NOT an assertion: today, attaching alone does
    // not rescue the parked run. Review pushed back on asserting that (PR #36)
    // and was right — pinning it would freeze a design decision that is still
    // open, and block a future kernel that re-elects parked steps on attach.
    // Either behaviour is acceptable here; what must hold is the line below.
    const passive = await Promise.race([
      dispatched,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
    if (passive !== null) {
      // A kernel that re-drives on attach has satisfied the real requirement
      // already — the step reached a worker. Nothing further to prove.
      await worker.close();
      starter.close();
      return;
    }

    // Otherwise run.resume must be able to pick it up.
    await starter.runResume(runId);
    const resumed = await Promise.race([
      dispatched,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);
    expect(resumed, 'run.resume must dispatch the parked step to the attached worker').not.toBeNull();

    await worker.close();
    starter.close();
  }, 45_000);

  it('reports a real manual-recovery NeedsHuman state as parked', async () => {
    const dataDir = temporaryDirectory('flows-live-human-');
    await startDaemon(dataDir);
    const flow = join(dataDir, 'manual.flow.yaml');
    writeFileSync(flow, `
version: '0.1.0'
steps:
  - id: edit
    type: agent
    cli: ${JSON.stringify(join(TESTDATA, 'preflight', 'authenticated-cli'))}
    instruction: Edit the repository.
    recoveryMode: manual
    maxIterations: 2
    surfaces:
      workspace:
        - surface: repo
`);
    const worker = await connectClient(dataDir);
    await worker.hello('live-manual-worker');
    const dispatched = eventOnce<StepDispatchEvent>(worker, 'step.dispatch');
    await worker.workerAttach('live-manual-agent', ['agent'], {
      workspace: [{ surface: 'repo', revision_id: 'rev-a' }],
      streams: [],
    });

    const running = invokeCliAsync(['run', '--data-dir', dataDir, flow]);
    const lease = await dispatched;
    await worker.close();
    const parked = await running;

    expect(parked.status, parked.stderr).toBe(3);
    expect(parked.stderr).toContain('PARKED [run_parked]');
    expect(parked.stderr).toContain('waiting for human recovery');
    expect(parked.stderr).not.toContain('protocol_error');
    const inspector = await connectClient(dataDir);
    expect((await inspector.runGet(lease.run_id)).steps[lease.step_id]).toMatchObject({
      type: 'agent',
      state: 'needs_human',
    });
  });

  it('runs hn-monitor analyze-story end-to-end via a stub agent CLI (gate 2 clause 2 demo)', async () => {
    // RFC-0001 gate 2 second clause: the real proactive workload
    // (hn-monitor) actually RUNS as a relayflow — not just dispatches
    // and fails with worker_error because no CLI is wired. This test
    // proves the pipeline works today with a stub CLI that satisfies
    // the analyze-story step's json_schema verification. A real
    // analyzer would replace the stub with `claude -p` or similar;
    // that follow-up is orthogonal to whether the plumbing works.
    //
    // Ordering matters: worker MUST attach BEFORE submit_event, or
    // the run parks with nothing to drive it (see the "late-attaching
    // worker" test above for the recorded gotcha).
    const dataDir = temporaryDirectory('flows-live-hn-agent-');
    await startDaemon(dataDir);
    const client = await connectClient(dataDir);
    await client.hello('live-hn-agent');
    const worker = new AgentWorker(client, {
      workerId: 'live-hn-agent-worker',
      pins: {
        workspace: [{ surface: 'repo', revision_id: 'rev-a' }],
        streams: [],
      },
    });
    await worker.attach();

    // Load hn-monitor's canonical spec, then patch the analyze-story
    // step to declare a real CLI. The canonical fixture is separately pinned
    // to the authoring YAML, whose `output:` compiles to this json_schema.
    const spec = JSON.parse(
      readFileSync(join(TESTDATA, 'hn-monitor.spec.canonical.json'), 'utf8'),
    ) as { steps: { id: string; cli?: string }[] };
    for (const step of spec.steps) {
      if (step.id === 'analyze-story') {
        step.cli = join(TESTDATA, 'preflight', 'analyze-story-stub-cli');
      }
    }

    // Submit the trigger event. The kernel matches it against the
    // hn-story-posted subscription, spawns a run, and dispatches the
    // agent step to our attached worker. Worker runs the stub CLI,
    // which outputs JSON that satisfies the step's json_schema gate,
    // reports stepComplete with success.
    const outcome = await client.eventSubmit(spec, {
      type: 'hn.story_posted',
      payload: { id: 42_000_042, type: 'story' },
    });
    expect(outcome).toMatchObject({ matched: true, deduped: false });
    const runId = (outcome as { run: { run_id: string } }).run.run_id;

    // The step must reach 'done' — not 'failed', not 'runnable' — and
    // the run must complete with a success-shaped final entry.
    expect(await waitForStep(client, runId, 'analyze-story', 'done')).toMatchObject({
      type: 'agent',
      state: 'done',
    });
    const finalEntries = (await client.journalRead(runId)).entries;
    const stepCompleted = finalEntries.find(
      (entry) => (entry as { entry_type: string; step_id?: string }).entry_type === 'step.completed'
        && (entry as { step_id?: string }).step_id === 'analyze-story',
    ) as { payload: { output: unknown; verification: unknown } } | undefined;
    expect(stepCompleted?.payload).toMatchObject({
      output: {
        story_title: 'stub',
        relevance_score: 5,
        reasoning: 'stub agent runtime — deterministic output for gate-2 clause-2 demo',
      },
      verification: { gate: 'json_schema', verdict: 'pass' },
    });
    const runCompleted = finalEntries.find(
      (entry) => (entry as { entry_type: string }).entry_type === 'run.completed',
    ) as { payload: { completionReason: string } } | undefined;
    expect(runCompleted?.payload.completionReason).toBe('success');

    await worker.close();
  }, 30_000);

  it('hn-monitor analyze-story FAILS verification when the CLI omits required schema fields', async () => {
    // Negative pin for the "schema gate stays live" invariant. The
    // stub emits `{"story_title":"partial"}` (missing
    // relevance_score, reasoning). With json_schema active over the
    // PROMOTED payload, the schema author's declared shape has
    // required fields the stub omitted; verification must fail.
    //
    // NOTE on mutation coverage: this test does NOT catch a revert
    // of the promotion (wrapper-as-output) — under that mutation
    // the CliResult wrapper also fails the schema (it lacks
    // story_title/relevance_score/reasoning entirely), so the run
    // still ends in step_failed and this assertion still passes.
    // That mutation IS caught by the positive test above, which
    // requires the run to complete with 'success' — the wrapper
    // path fails that. What THIS test catches is a
    // schema-gate-removed mutation: if the kernel stopped running
    // json_schema verification, the stub's exit-0 with any JSON
    // would slide through to 'success', and this test would fail
    // because the reason would BE 'success' not 'step_failed'.
    const dataDir = temporaryDirectory('flows-live-hn-agent-neg-');
    await startDaemon(dataDir);
    const client = await connectClient(dataDir);
    await client.hello('live-hn-agent-neg');
    const worker = new AgentWorker(client, {
      workerId: 'live-hn-agent-neg-worker',
      pins: {
        workspace: [{ surface: 'repo', revision_id: 'rev-a' }],
        streams: [],
      },
    });
    await worker.attach();

    const spec = JSON.parse(
      readFileSync(join(TESTDATA, 'hn-monitor.spec.canonical.json'), 'utf8'),
    ) as { steps: { id: string; cli?: string }[] };
    for (const step of spec.steps) {
      if (step.id === 'analyze-story') {
        step.cli = join(TESTDATA, 'preflight', 'analyze-story-missing-fields-cli');
      }
    }

    const outcome = await client.eventSubmit(spec, {
      type: 'hn.story_posted',
      payload: { id: 42_000_099, type: 'story' },
    });
    expect(outcome).toMatchObject({ matched: true, deduped: false });
    const runId = (outcome as { run: { run_id: string } }).run.run_id;

    // The step must NOT reach success. Poll for run.completed and
    // assert TWO things: (a) the terminal entry actually arrived
    // (a never-completing run is a test bug, not a pass — a
    // `.not.toBe('success')` check on undefined would trivially
    // pass), and (b) the reason is a declared FAILURE kind, not
    // a "hasn't completed yet" absence.
    const deadline = Date.now() + 10_000;
    let runCompleted: { payload: { completionReason: string } } | undefined;
    let stepCompleted: {
      payload: { completionReason: string; output: unknown; verification: unknown };
    } | undefined;
    while (Date.now() < deadline) {
      const entries = (await client.journalRead(runId)).entries;
      stepCompleted = entries.find(
        (entry) => (entry as { entry_type: string; step_id?: string }).entry_type === 'step.completed'
          && (entry as { step_id?: string }).step_id === 'analyze-story',
      ) as typeof stepCompleted;
      runCompleted = entries.find(
        (entry) => (entry as { entry_type: string }).entry_type === 'run.completed',
      ) as { payload: { completionReason: string } } | undefined;
      if (runCompleted !== undefined) break;
      await delay(50);
    }
    expect(
      runCompleted,
      'run.completed entry never arrived within 10s — test cannot assert schema-live under a hung run',
    ).toBeDefined();
    // step_failed is the outer reason (a step failed → run failed). With one
    // allowed semantic execution, the step records retries_exhausted while
    // its verification record names the json_schema rejection. The rejected
    // parsed value is nulled before the completion is persisted.
    expect(stepCompleted?.payload).toMatchObject({
      completionReason: 'retries_exhausted',
      output: null,
      verification: { gate: 'json_schema', verdict: 'fail' },
    });
    expect(runCompleted!.payload.completionReason).toBe('step_failed');

    await worker.close();
  }, 30_000);

  it('agent step preserves the CliResult wrapper as output when the CLI emits non-JSON text', async () => {
    // Pins the promise in worker.ts's promotion comment: "Non-JSON
    // stdout falls back to the wrapper so text-emitting tools still
    // round-trip usefully." Without this test, a future refactor
    // that deletes `?? result` or narrows parseJsonOutput's return
    // shape could silently discard stdout/stderr/exit_code from
    // `output` for every text-emitting agent CLI — the two hn-monitor
    // tests above would stay green because their stubs emit pure JSON.
    //
    // The kernel nulls `output` on step.completed when verification
    // fails (a design choice — the failed output is noise, not state
    // to persist). To observe the wrapper's preservation, this test
    // uses a spec WITHOUT `json_schema` verification: the step
    // succeeds cleanly and the CliResult wrapper lands in the
    // journal intact.
    const dataDir = temporaryDirectory('flows-live-text-fallback-');
    await startDaemon(dataDir);
    const cli = join(TESTDATA, 'preflight', 'analyze-story-text-only-cli');
    const client = await connectClient(dataDir);
    await client.hello('live-text-fallback');
    const worker = new AgentWorker(client, {
      workerId: 'live-text-fallback-worker',
      pins: {
        workspace: [{ surface: 'repo', revision_id: 'rev-a' }],
        streams: [],
      },
    });
    await worker.attach();

    const started = await client.runStart(toKernelSpec(compileYaml(`
version: '0.1.0'
steps:
  - id: analyze
    type: agent
    cli: ${JSON.stringify(cli)}
    instruction: Emit some text.
`)));

    // Poll for step.completed and inspect its output.
    const deadline = Date.now() + 10_000;
    let stepCompleted: { payload: { output: unknown } } | undefined;
    while (Date.now() < deadline) {
      const entries = (await client.journalRead(started.run_id)).entries;
      stepCompleted = entries.find(
        (entry) => (entry as { entry_type: string; step_id?: string }).entry_type === 'step.completed'
          && (entry as { step_id?: string }).step_id === 'analyze',
      ) as { payload: { output: unknown } } | undefined;
      if (stepCompleted !== undefined) break;
      await delay(50);
    }
    expect(stepCompleted, 'step.completed never arrived').toBeDefined();
    const output = stepCompleted!.payload.output as {
      exit_code: number | null;
      stdout_tail: string;
      stderr_tail: string;
    };
    // Wrapper survived: text stdout preserved verbatim, exit_code
    // preserved, stderr channel preserved. If a future refactor
    // dropped `?? result` from worker.ts, `output` would be `null`
    // here (parseJsonOutput returned null on non-JSON stdout) and
    // these assertions would all fail.
    expect(output).not.toBeNull();
    expect(output.exit_code).toBe(0);
    expect(output.stdout_tail).toContain('looked at the story');
    expect(output.stderr_tail).toBe('');

    await worker.close();
  }, 30_000);

  it('AgentWorker exposes wake_context to the CLI via RELAYFLOW_WAKE_CONTEXT env var (real analyzer prerequisite)', async () => {
    // Gate 2 clause 2 follow-up A: a real hn-monitor analyzer needs
    // to see the triggering event (specifically the story ID) to
    // fetch/analyze the actual story. Before this PR: the kernel's
    // dispatch event carried wake_context in its wire shape, but
    // the SDK type didn't expose it and AgentWorker didn't pass it
    // anywhere. This test pins the end-to-end wiring: kernel scans
    // the run journal for subscription.matched → puts wake_context
    // in the dispatch → SDK type surfaces it → AgentWorker sets
    // $RELAYFLOW_WAKE_CONTEXT in the subprocess env → the CLI reads
    // it and echoes the payload ID back inside the analysis JSON.
    //
    const dataDir = temporaryDirectory('flows-live-wake-context-');
    await startDaemon(dataDir);
    const client = await connectClient(dataDir);
    await client.hello('live-wake-context');
    const worker = new AgentWorker(client, {
      workerId: 'live-wake-context-worker',
      pins: {
        workspace: [{ surface: 'repo', revision_id: 'rev-a' }],
        streams: [],
      },
    });
    await worker.attach();

    const spec = JSON.parse(
      readFileSync(join(TESTDATA, 'hn-monitor.spec.canonical.json'), 'utf8'),
    ) as { steps: { id: string; cli?: string }[] };
    for (const step of spec.steps) {
      if (step.id === 'analyze-story') {
        step.cli = join(TESTDATA, 'preflight', 'analyze-story-echo-wake-cli');
      }
    }

    // Distinctive story ID so the assertion can prove the CLI saw
    // THIS specific event's payload, not a fixture default.
    const storyId = 42_007_777;
    const outcome = await client.eventSubmit(spec, {
      type: 'hn.story_posted',
      payload: { id: storyId, type: 'story' },
    });
    const runId = (outcome as { run: { run_id: string } }).run.run_id;

    expect(await waitForStep(client, runId, 'analyze-story', 'done')).toMatchObject({
      type: 'agent',
      state: 'done',
    });

    // Prove the CLI actually SAW the wake context: the promoted
    // output should include the story_id echoed inside story_title.
    // A run that succeeded without the env var reaching the CLI
    // would still complete (the stub exits 1, which propagates as
    // step failed) — this positive branch requires the env var to
    // have been populated correctly.
    const entries = (await client.journalRead(runId)).entries;
    const stepCompleted = entries.find(
      (entry) => (entry as { entry_type: string; step_id?: string }).entry_type === 'step.completed'
        && (entry as { step_id?: string }).step_id === 'analyze-story',
    ) as { payload: { output: { story_title: string; reasoning: string } } } | undefined;
    expect(stepCompleted).toBeDefined();
    expect(stepCompleted!.payload.output.story_title).toBe(`echoed:${storyId}`);
    expect(stepCompleted!.payload.output.reasoning).toContain(String(storyId));

    await worker.close();
  }, 30_000);

  it('AgentWorker leaves RELAYFLOW_WAKE_CONTEXT UNSET when the run has no wake_context (undefined-vs-null pin)', async () => {
    // Pins the invariant the worker.ts comment makes load-bearing:
    // "The env-var-absent shape is deliberate so a CLI that checks
    // `$RELAYFLOW_WAKE_CONTEXT` can distinguish 'no wake context
    // available' from 'wake context is JSON null'." A future
    // simplification that always sets the var (to `""` or `"null"`
    // when the dispatch has no wake_context) would break every
    // CLI that keys on `if [ -z "$RELAYFLOW_WAKE_CONTEXT" ]` — and
    // without this test, no other test would fail.
    //
    // Uses runStart (not eventSubmit) to spawn a run WITHOUT a
    // triggering event, so the kernel dispatches an agent step
    // whose StepDispatch has no `wake_context` field.
    //
    // POLLUTES process.env FIRST so this also catches the parent-
    // inheritance leak. Without the `delete env[WAKE_CONTEXT_ENV]`
    // in worker.ts, `{ ...process.env }` would carry this stale
    // value into the child even on a run with no wake_context —
    // the probe would see `env_present: true` and the assertion
    // below would fail. A wrapper script, systemd unit, docker
    // env, or a prior test in the same process can set this in
    // real deployments; the guarantee has to be enforced by the
    // spawn, not by luck.
    process.env.RELAYFLOW_WAKE_CONTEXT = '{"parent_leak_check": true}';
    const dataDir = temporaryDirectory('flows-live-wake-context-absent-');
    await startDaemon(dataDir);
    const cli = join(TESTDATA, 'preflight', 'wake-context-probe-cli');
    const client = await connectClient(dataDir);
    await client.hello('live-wake-context-absent');
    const worker = new AgentWorker(client, {
      workerId: 'live-wake-context-absent-worker',
      pins: {
        workspace: [{ surface: 'repo', revision_id: 'rev-a' }],
        streams: [],
      },
    });
    await worker.attach();

    const started = await client.runStart(toKernelSpec(compileYaml(`
version: '0.1.0'
steps:
  - id: probe
    type: agent
    cli: ${JSON.stringify(cli)}
    instruction: Report presence of wake-context env var.
`)));

    expect(await waitForStep(client, started.run_id, 'probe', 'done')).toMatchObject({
      type: 'agent',
      state: 'done',
    });

    // The probe emits `{"env_present": <bool>}`. When wake_context
    // is truly absent (undefined, not `null`), the env var must
    // NOT be set — the probe must see `env_present: false`.
    const entries = (await client.journalRead(started.run_id)).entries;
    const completed = entries.find(
      (entry) => (entry as { entry_type: string; step_id?: string }).entry_type === 'step.completed'
        && (entry as { step_id?: string }).step_id === 'probe',
    ) as { payload: { output: { env_present: boolean } } } | undefined;
    expect(completed).toBeDefined();
    expect(completed!.payload.output.env_present).toBe(false);

    delete process.env.RELAYFLOW_WAKE_CONTEXT;

    await worker.close();
  }, 30_000);

  it('AgentWorker passes a declared model to an identified wrapper as RELAYFLOW_MODEL', async () => {
    // The whole point of declaring `model` on the step is that the CLI
    // stops inheriting whatever the host pinned. This proves the declared
    // value survives the full boundary: SDK compile → kernel parse →
    // dispatch → AgentWorker → subprocess env.
    const dataDir = temporaryDirectory('flows-live-model-set-');
    await startDaemon(dataDir);
    const cli = join(dataDir, 'echo-model-cli');
    writeFileSync(cli, readFileSync(join(TESTDATA, 'preflight', 'echo-model-cli')));
    writeFileSync(
      join(dataDir, 'wrapper-session.mjs'),
      readFileSync(join(TESTDATA, 'preflight', 'wrapper-session.mjs')),
    );
    chmodSync(cli, 0o755);
    writeFileSync(join(dataDir, 'flows.json'), JSON.stringify({ models: ['declared-model-xyz'] }));
    const flowPath = join(dataDir, 'relative-wrapper.flow.yaml');
    writeFileSync(flowPath, `
version: '0.1.0'
agents:
  model-probe:
    cli: ./echo-model-cli
    model: declared-model-xyz
steps:
  - id: probe
    type: agent
    agent: model-probe
    instruction: Report the model env var.
`);
    const client = await connectClient(dataDir);
    await client.hello('live-model-set');
    const worker = new AgentWorker(client, {
      workerId: 'live-model-set-worker',
      pins: { workspace: [{ surface: 'repo', revision_id: 'rev-a' }], streams: [] },
    });
    await worker.attach();

    const checked = checkFlow(flowPath);
    expect(checked.report.ok).toBe(true);
    const compiled = checked.flow!;
    expect(compiled).toHaveProperty('agents.model-probe.model', 'declared-model-xyz');
    expect(compiled.steps[0]).toMatchObject({
      type: 'agent',
      agent: 'model-probe',
      cli,
    });
    expect(compiled.steps[0]).not.toHaveProperty('model');
    const kernel = toKernelSpec(compiled);
    expect(kernel).not.toHaveProperty('agents');
    expect(kernel.steps[0]).not.toHaveProperty('agent');
    expect(kernel.steps[0]).toMatchObject({ cli, model: 'declared-model-xyz' });
    const started = await client.runStart(kernel);

    expect(await waitForStep(client, started.run_id, 'probe', 'done')).toMatchObject({
      type: 'agent',
      state: 'done',
    });
    const entries = (await client.journalRead(started.run_id)).entries;
    const spawned = entries.find(
      (entry) => (entry as { entry_type: string }).entry_type === 'run.spawned',
    ) as { payload: { spec: { steps: Array<{ model?: string }> } } } | undefined;
    expect(spawned?.payload.spec.steps[0]?.model).toBe('declared-model-xyz');
    const completed = entries.find(
      (entry) => (entry as { entry_type: string; step_id?: string }).entry_type === 'step.completed'
        && (entry as { step_id?: string }).step_id === 'probe',
    ) as { payload: { output: { story_title: string } } } | undefined;
    expect(completed).toBeDefined();
    expect(completed!.payload.output.story_title).toBe('model:declared-model-xyz');

    await worker.close();
  }, 30_000);

  it('AgentWorker refuses a nonconforming journal-submitted wrapper before exposing RELAYFLOW_MODEL', async () => {
    const dataDir = temporaryDirectory('flows-live-wrapper-identity-');
    await startDaemon(dataDir);
    const cli = join(dataDir, 'not-a-relayflows-wrapper');
    const evidence = join(dataDir, 'wrapper-evidence.json');
    writeFileSync(cli, `#!/bin/sh
case "$1 $2" in
  "--relayflows-adapter-v1 ") printf '%s\\n' relayflows-agent-cli-v1 ;;
  "auth status") exit 0 ;;
  *) exit 9 ;;
esac
`);
    chmodSync(cli, 0o755);
    writeFileSync(join(dataDir, 'flows.json'), JSON.stringify({ models: ['declared-model-xyz'] }));
    const flowSource = `
version: '0.1.0'
steps:
  - id: probe
    type: agent
    cli: ${JSON.stringify(cli)}
    model: declared-model-xyz
    instruction: This instruction must not execute.
`;
    const flowPath = join(dataDir, 'replacement.flow.yaml');
    writeFileSync(flowPath, flowSource);
    expect(checkFlow(flowPath).report.ok).toBe(true);

    // Replace the previously identified executable before dispatch. The
    // worker must bind trust to what it executes now, not an earlier check.
    writeFileSync(cli, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ argv: process.argv.slice(2), model: process.env.RELAYFLOW_MODEL ?? null }));
if (process.argv[2] === '--relayflows-adapter-v1') {
  process.stdout.write('not-the-required-token\\n');
  process.exit(0);
}
process.stdout.write('{"must_not":"execute"}');
`);
    chmodSync(cli, 0o755);
    const client = await connectClient(dataDir);
    await client.hello('live-wrapper-identity');
    const worker = new AgentWorker(client, {
      workerId: 'live-wrapper-identity-worker',
      pins: { workspace: [{ surface: 'repo', revision_id: 'rev-a' }], streams: [] },
    });
    await worker.attach();

    // Submit the compiled kernel object directly, as journal clients can.
    const started = await client.runStart(toKernelSpec(compileYaml(flowSource)));

    expect(await waitForStep(client, started.run_id, 'probe', 'done')).toMatchObject({
      type: 'agent',
      state: 'done',
    });
    expect(JSON.parse(readFileSync(evidence, 'utf8'))).toEqual({
      argv: ['--relayflows-adapter-v1'],
      model: null,
    });
    const completed = (await client.journalRead(started.run_id)).entries.find(
      (entry) => (entry as { entry_type: string; step_id?: string }).entry_type === 'step.completed'
        && (entry as { step_id?: string }).step_id === 'probe',
    );
    expect(completed).toMatchObject({
      payload: {
        completionReason: 'worker_error',
      },
    });

    await worker.close();
  }, 30_000);

  it.each([
    ['claude', '-p --model declared-model-xyz'],
    ['codex', 'exec --ephemeral --skip-git-repo-check --model declared-model-xyz'],
  ] as const)('AgentWorker executes the raw %s adapter with its real model flag', async (name, prefix) => {
    const dataDir = temporaryDirectory(`flows-live-${name}-adapter-`);
    await startDaemon(dataDir);
    const cli = join(dataDir, name);
    writeFileSync(cli, `#!/bin/sh
case "$*" in
  ${JSON.stringify(`${prefix} `)}*) ;;
  *) printf '%s\\n' "unexpected argv: $*" >&2; exit 9 ;;
esac
test "\${RELAYFLOW_MODEL+x}" != x || exit 8
printf '%s' '{"adapter":"${name}","model_flag":"declared-model-xyz"}'
`);
    chmodSync(cli, 0o755);
    const client = await connectClient(dataDir);
    await client.hello(`live-${name}-adapter`);
    const worker = new AgentWorker(client, {
      workerId: `live-${name}-adapter-worker`,
      pins: { workspace: [{ surface: 'repo', revision_id: 'rev-a' }], streams: [] },
    });
    await worker.attach();

    const started = await client.runStart(toKernelSpec(compileYaml(`
version: '0.1.0'
steps:
  - id: probe
    type: agent
    cli: ${JSON.stringify(cli)}
    model: declared-model-xyz
    instruction: Report the adapter.
`)));

    expect(await waitForStep(client, started.run_id, 'probe', 'done')).toMatchObject({ state: 'done' });
    const completed = (await client.journalRead(started.run_id)).entries.find(
      (entry) => (entry as { entry_type: string; step_id?: string }).entry_type === 'step.completed'
        && (entry as { step_id?: string }).step_id === 'probe',
    ) as { payload: { output: { adapter: string; model_flag: string } } } | undefined;
    expect(completed?.payload.output).toEqual({ adapter: name, model_flag: 'declared-model-xyz' });

    await worker.close();
  }, 30_000);

  it('AgentWorker leaves RELAYFLOW_MODEL UNSET when the step declares no model', async () => {
    // Absence must stay absence, so a CLI can apply its own default and a
    // reader can tell "the author chose nothing" from "the author chose".
    //
    // POLLUTES process.env FIRST, which is the real point: without the
    // explicit `delete env[MODEL_ENV]` in worker.ts, `{ ...process.env }`
    // would carry this stale value into the child and a step that declared
    // NO model would silently run pinned to whatever the launching shell
    // exported. That is exactly the ambient-state failure this field was
    // added to remove, so it has to be enforced by the spawn, not by luck.
    // Without this test nothing else would catch it.
    process.env.RELAYFLOW_MODEL = 'leaked-parent-model';
    const dataDir = temporaryDirectory('flows-live-model-unset-');
    await startDaemon(dataDir);
    const cli = join(TESTDATA, 'preflight', 'echo-model-cli');
    const client = await connectClient(dataDir);
    await client.hello('live-model-unset');
    const worker = new AgentWorker(client, {
      workerId: 'live-model-unset-worker',
      pins: { workspace: [{ surface: 'repo', revision_id: 'rev-a' }], streams: [] },
    });
    await worker.attach();

    const started = await client.runStart(toKernelSpec(compileYaml(`
version: '0.1.0'
steps:
  - id: probe
    type: agent
    cli: ${JSON.stringify(cli)}
    instruction: Report the model env var.
`)));

    expect(await waitForStep(client, started.run_id, 'probe', 'done')).toMatchObject({
      type: 'agent',
      state: 'done',
    });
    const entries = (await client.journalRead(started.run_id)).entries;
    const completed = entries.find(
      (entry) => (entry as { entry_type: string; step_id?: string }).entry_type === 'step.completed'
        && (entry as { step_id?: string }).step_id === 'probe',
    ) as { payload: { output: { story_title: string } } } | undefined;
    expect(completed).toBeDefined();
    // UNSET, not EMPTY and not the leaked parent value.
    expect(completed!.payload.output.story_title).toBe('model:UNSET');

    delete process.env.RELAYFLOW_MODEL;

    await worker.close();
  }, 30_000);

  it('hn-monitor analyze-story reaches done through the real Claude analyzer CLI', async (context) => {
    // RFC-0001 gate 2 acceptance: the canonical hn-monitor spec's
    // analyze-story step completes against a REAL analyzer — one
    // that calls an LLM — not a stub whose answer was written by
    // hand. Every test above pins plumbing with deterministic
    // fixtures; this one pins that the plumbing carries a real
    // analysis: kernel matches the event, dispatches to AgentWorker,
    // the analyzer reads $RELAYFLOW_WAKE_CONTEXT, invokes `claude`,
    // and the model's own JSON passes the canonical json_schema gate
    // (verdict recorded by the kernel, asserted below).
    const cli = join(TESTDATA, 'preflight', 'analyze-story-claude-cli');
    const readiness = probeAnalyzer(cli);
    if (!readiness.ready) {
      // An unavailable analyzer is diagnostics, never acceptance, so
      // this FAILS by default. Skipping is
      // the opt-in, not the default: a reader who runs the suite
      // without special knowledge must not get a green that proves
      // nothing about gate 2. RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 is for
      // environments that knowingly cannot reach a model and are not
      // counting this run as gate evidence.
      const notice = `LIVE_ANALYZER_UNAVAILABLE: ${readiness.detail}`;
      if (process.env['RELAYFLOWS_ALLOW_ANALYZER_SKIP'] !== '1') {
        throw new Error(
          `${notice} — failing because gate-2 acceptance requires the real analyzer to execute. `
          + 'Set RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 only if this run is not gate evidence.',
        );
      }
      console.warn(`${notice} — SKIPPING. This skip is diagnostics, not gate-2 acceptance evidence.`);
      context.skip();
      return;
    }
    console.log(`LIVE_ANALYZER ready: ${readiness.detail}`);

    const dataDir = temporaryDirectory('flows-live-real-analyzer-');
    await startDaemon(dataDir);
    const client = await connectClient(dataDir);
    await client.hello('live-real-analyzer');
    const worker = new AgentWorker(client, {
      workerId: 'live-real-analyzer-worker',
      pins: {
        workspace: [{ surface: 'repo', revision_id: 'rev-a' }],
        streams: [],
      },
    });
    // Attach BEFORE eventSubmit or the run parks with nothing to
    // drive it (recorded in the late-attaching-worker test above).
    await worker.attach();

    // The canonical spec AS SHIPPED — its own declared `cli`, not one
    // patched in by the test. An earlier version of this test injected
    // the analyzer path here, which proved the analyzer worked while
    // leaving `flows hn-monitor start` shipping a spec with no CLI at
    // all: green test, dead workload. The only transformation applied
    // is the one the real runner applies, via the same exported
    // function, so what runs here is what runs when launched.
    const specPath = join(TESTDATA, 'hn-monitor.spec.canonical.json');
    const spec = resolveSpecCliPaths(
      JSON.parse(readFileSync(specPath, 'utf8')) as {
        steps: { id: string; cli?: string; verification?: { json_schema?: unknown } }[];
      },
      specPath,
    );
    const declared = spec.steps.find((step) => step.id === 'analyze-story');
    expect(declared?.cli).toBe(cli);

    // The event frame carries the story metadata a real HN webhook
    // delivers, so acceptance does not depend on firebase being
    // reachable. The analyzer's fetch path is its fallback for
    // title-less frames and is deliberately NOT exercised here: it
    // needs live network, and a flaky network would then be able to
    // fail the gate-2 acceptance signal. It is covered by the
    // analyzer's own contract, not by this harness.
    //
    // The title carries a nonce. Nothing else on the machine or in the
    // model's training data contains it, so the analyzer can only echo
    // it back by having received THIS event's wake context — which is
    // what makes the story_title assertion below a real check on
    // context delivery rather than a check that some story arrived.
    const nonce = 'wake-nonce-7f3a91c4';
    const story = {
      id: 41_380_628,
      type: 'story',
      by: 'pg',
      title: `Show HN: an agent that opens and reviews its own pull requests [${nonce}]`,
      url: 'https://example.com/self-reviewing-agent',
    };
    const outcome = await client.eventSubmit(spec, { type: 'hn.story_posted', payload: story });
    expect(outcome).toMatchObject({ matched: true, deduped: false });
    const runId = (outcome as { run: { run_id: string } }).run.run_id;

    // A model round-trip is seconds, not milliseconds — the default 5s
    // step deadline is a fixture budget, not an LLM one. The budgets
    // nest deliberately: this 150s wait is shorter than the 180s test
    // timeout below, so a slow model surfaces as this assertion timing
    // out (which names the step and state) rather than as vitest
    // killing the case with no indication of what was pending.
    expect(await waitForStep(client, runId, 'analyze-story', 'done', 150_000)).toMatchObject({
      type: 'agent',
      state: 'done',
    });

    const entries = (await client.journalRead(runId)).entries;
    const stepCompleted = entries.find(
      (entry) => (entry as { entry_type: string; step_id?: string }).entry_type === 'step.completed'
        && (entry as { step_id?: string }).step_id === 'analyze-story',
    ) as {
      payload: {
        verification: { gate: string; verdict: string };
        output: { story_title: unknown; relevance_score: unknown; reasoning: unknown };
      };
    } | undefined;
    expect(stepCompleted).toBeDefined();

    // "Passes the canonical schema" is the kernel's own verdict over
    // the promoted output, not the test re-deriving it: the spec is
    // the unmodified canonical one, so this record is the gate.
    expect(stepCompleted!.payload.verification).toMatchObject({
      gate: 'json_schema',
      verdict: 'pass',
    });

    const analysis = stepCompleted!.payload.output;
    console.log(`LIVE_ANALYZER analysis: ${JSON.stringify(analysis)}`);
    // The analysis is about THIS story and is a real answer, not a
    // placeholder. The title must come back with the nonce intact,
    // which only an analyzer that received this event's wake context
    // can produce. The reasoning bar is set where a terse placeholder
    // fails but any genuine model sentence clears it comfortably —
    // observed replies run 200+ characters.
    expect(analysis.story_title).toBe(story.title);
    expect(analysis.story_title as string).toContain(nonce);
    expect(Number.isInteger(analysis.relevance_score)).toBe(true);
    expect(analysis.relevance_score as number).toBeGreaterThanOrEqual(1);
    expect(analysis.relevance_score as number).toBeLessThanOrEqual(10);
    expect(typeof analysis.reasoning).toBe('string');
    expect((analysis.reasoning as string).length).toBeGreaterThan(100);

    const runCompleted = entries.find(
      (entry) => (entry as { entry_type: string }).entry_type === 'run.completed',
    ) as { payload: { completionReason: string } } | undefined;
    expect(runCompleted?.payload.completionReason).toBe('success');

    await worker.close();
  }, 180_000);

  it('preflights before journaling and names an unreachable socket', async () => {
    const dataDir = temporaryDirectory('flows-live-preflight-');
    await startDaemon(dataDir);
    const before = runArtifacts(dataDir);

    const refused = invokeCli([
      'run', '--data-dir', dataDir, join(TESTDATA, 'preflight', 'cli-missing.flow.yaml'),
    ]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('REFUSED [cli_missing]');
    expect(runArtifacts(dataDir)).toEqual(before);

    // `--no-spawn` is what still makes an absent daemon a refusal: `flows run`
    // otherwise starts one (kernel/DAEMON-LIFECYCLE.md §3, §4). The property
    // this case pins -- refused before any journal write, naming the socket --
    // is unchanged, and `runArtifacts(absentDir)` below still proves it.
    const absentDir = temporaryDirectory('flows-live-absent-');
    const absentSocket = join(absentDir, 'relayflowd.sock');
    const unreachable = invokeCli([
      'run', '--no-spawn', '--data-dir', absentDir, join(TESTDATA, 'hello-deterministic.flow.yaml'),
    ]);
    expect(unreachable.status).toBe(2);
    expect(unreachable.stderr).toContain('REFUSED [daemon_unreachable]');
    expect(unreachable.stderr).toContain(absentSocket);
    expect(unreachable.stderr).toContain('relayflowd --data-dir');
    expect(runArtifacts(absentDir)).toEqual([]);
  });

  // kernel/DAEMON-LIFECYCLE.md §6 test 15, against the real binary: the
  // property is enforced by the daemon's `flock(2)`, so nothing short of two
  // real relayflowd processes contending for one data dir tests it. The
  // CLI-side half (a losing child exits 3 and its CLI keeps polling) is
  // covered hermetically in daemon-lifecycle-live.test.ts.
  it('starts exactly one daemon when two runs race for one empty data dir', async () => {
    const dataDir = join(temporaryDirectory('flows-live-race-'), 'data');
    const flow = join(TESTDATA, 'hello-deterministic.flow.yaml');

    const [first, second] = await Promise.all([
      invokeCliAsync(['run', '--data-dir', dataDir, flow]),
      invokeCliAsync(['run', '--data-dir', dataDir, flow]),
    ]);

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(first.stdout).toContain('completionReason: success');
    expect(second.stdout).toContain('completionReason: success');

    // One socket, one owner. `ps` rather than the connection file, because the
    // question is how many PROCESSES survived, and a file can only ever name
    // the last writer.
    const surviving = spawnSync('/bin/sh', ['-c', `ps ax -o pid=,command= | grep -F -- '--data-dir ${dataDir} serve' | grep -v grep`], { encoding: 'utf8' })
      .stdout.split('\n').filter((line) => line.trim().length > 0);
    for (const line of surviving) {
      const pid = Number.parseInt(line.trim().split(/\s+/)[0]!, 10);
      if (Number.isInteger(pid)) daemonPids.push(pid);
    }
    expect(surviving, surviving.join('\n')).toHaveLength(1);

    // Two runs, two journals: both CLIs reached the same daemon rather than
    // one of them quietly reusing the other's run.
    expect(runJournals(dataDir)).toHaveLength(2);
  }, 60_000);
});

describe('JournalClient wire conformance against live relayflowd', () => {
  it('exercises every protocol-v0 verb with the real server', async () => {
    const dataDir = temporaryDirectory('flows-live-wire-');
    await startDaemon(dataDir);
    const client = await connectClient(dataDir);

    expect(await client.hello('live-conformance')).toEqual({ protocol: 0, server: 'relayflowd' });
    const deterministic = await client.runStart(toKernelSpec(compileYaml(`
version: '0.1.0'
steps:
  - id: hello
    type: deterministic
    command: printf hello
`)));
    expect(deterministic.status).toBe('completed');
    expect(deterministic.completion_reason).toBe('success');
    expect((await client.runResume(deterministic.run_id)).completion_reason).toBe('success');
    expect((await client.runGet(deterministic.run_id)).status).toBe('completed');

    const replayed = eventOnce<Record<string, unknown>>(client, 'entry');
    expect(await client.runWatch(deterministic.run_id)).toEqual({ watching: deterministic.run_id });
    expect((await replayed)['entry_type']).toBe('run.spawned');
    const journal = await client.journalRead(deterministic.run_id, 1);
    expect(journal.entries.some((entry) => journalType(entry) === 'run.completed')).toBe(true);
    // `event.emit` and `stream.append` are mutations, and this run is terminal.
    // Parallel dispatch (#137) admits every mutating verb through
    // `ensure_mutable`, so both are refused here. They used to be accepted, and
    // `stream.append` journalled `stream.appended` AFTER `run.completed` —
    // producing a journal the daemon could no longer fold on resume. The
    // success paths below exercise the same two verbs against a live run, which
    // is the only state in which appending to a run's journal is meaningful.
    await expect(client.eventEmit(deterministic.run_id, 'unmatched', { ok: true }))
      .rejects.toMatchObject({ code: 'run_terminal' });
    await expect(client.streamAppend(deterministic.run_id, 'results', { answer: 4 }))
      .rejects.toMatchObject({ code: 'run_terminal' });
    expect(await client.streamRead(deterministic.run_id, 'results', 0, 10)).toEqual({
      messages: [],
      next_offset: 0,
    });

    const llmDispatch = eventOnce<StepDispatchEvent>(client, 'step.dispatch');
    expect(await client.workerAttach('live-llm', ['llm'])).toEqual({ worker_id: 'live-llm' });
    const llmStart = client.runStart(toKernelSpec(compileYaml(`
version: '0.1.0'
steps:
  - id: answer
    type: llm
    prompt: Return four.
`)));
    const llmLease = await llmDispatch;
    const llmParked = await llmStart;
    expect(llmLease.step_type).toBe('llm');
    const heartbeat = await client.stepHeartbeat(
      llmLease.run_id,
      llmLease.step_id,
      llmLease.attempt,
      llmLease.lease_id,
    );
    expect(heartbeat.lease_deadline_ms).toBeGreaterThan(Date.now());
    expect((await client.runGet(llmLease.run_id)).steps[llmLease.step_id]).toMatchObject({
      type: 'llm',
      state: 'running',
      lease_deadline_ms: heartbeat.lease_deadline_ms,
    });
    // Wire coverage for the two mutating verbs, on a live run this time.
    expect((await client.eventEmit(llmLease.run_id, 'unmatched', { ok: true })).matched).toBe(0);
    expect((await client.streamAppend(llmLease.run_id, 'results', { answer: 4 })).offset).toBe(0);
    expect(await client.streamRead(llmLease.run_id, 'results', 0, 10)).toEqual({
      messages: [{ answer: 4 }],
      next_offset: 1,
    });
    const llmDone = await client.stepComplete(
      llmLease.run_id,
      llmLease.step_id,
      llmLease.attempt,
      llmLease.idempotency_key,
      'success',
      { output: { answer: 4 }, usage: { tokens_in: 2, tokens_out: 1, dollars: '0.001' } },
    );
    expect(llmParked.status).toBe('parked');
    expect(llmDone.completion_reason).toBe('success');

    const initialPins = {
      workspace: [{ surface: 'repo', revision_id: 'rev-a' }],
      streams: [],
    };
    const agentDispatch = eventOnce<StepDispatchEvent>(client, 'step.dispatch');
    expect(await client.workerAttach('live-agent', ['agent'], initialPins)).toEqual({ worker_id: 'live-agent' });
    const agentStart = client.runStart(toKernelSpec(compileYaml(`
version: '0.1.0'
steps:
  - id: edit
    type: agent
    instruction: Edit the repository.
    surfaces:
      workspace:
        - surface: repo
      external:
        - provider://item
`)));
    const agentLease = await agentDispatch;
    await agentStart;
    let providerCalls = 0;
    expect(await client.performEffect({
      runId: agentLease.run_id,
      stepId: agentLease.step_id,
      attempt: agentLease.attempt,
      idempotencyKey: agentLease.idempotency_key,
      surfacePath: 'provider://item',
      revisionBefore: 'rev-a',
      revisionAfter: 'rev-b',
    }, async () => { providerCalls += 1; })).toBe(true);
    expect(providerCalls).toBe(1);
    const agentDone = await client.stepComplete(
      agentLease.run_id,
      agentLease.step_id,
      agentLease.attempt,
      agentLease.idempotency_key,
      'success',
      {
        output: { changed: true },
        started_pins: agentLease.pins,
        end_pins: { workspace: [{ surface: 'repo', revision_id: 'rev-b' }], streams: [] },
        effects: [{ surface_path: 'provider://item', idempotency_key: agentLease.idempotency_key }],
      },
    );
    expect(agentDone.completion_reason).toBe('success');
  });
});

describe('surface resume after a real daemon kill', () => {
  it('resumes a three-step run with each successful completion exactly once', async () => {
    const directory = temporaryDirectory('flows-live-resume-');
    const dataDir = join(directory, 'data');
    const startedMarker = join(directory, 'second-started');
    const releaseMarker = join(directory, 'release-first-attempt');
    const slowCommand = [
      `if [ -e ${JSON.stringify(startedMarker)} ]; then printf resumed`,
      `else : > ${JSON.stringify(startedMarker)}`,
      `while [ ! -e ${JSON.stringify(releaseMarker)} ]; do sleep 0.05; done`,
      'fi',
    ].join('; ');
    const flow = join(directory, 'three-step.flow.yaml');
    writeFileSync(flow, `
version: '0.1.0'
name: live-crash-resume
steps:
  - id: one
    type: deterministic
    command: printf one
  - id: two
    type: deterministic
    dependsOn: [one]
    command: ${JSON.stringify(slowCommand)}
  - id: three
    type: deterministic
    dependsOn: [two]
    command: printf three
`);
    const firstDaemon = await startDaemon(dataDir);
    const firstRun = invokeCliAsync(['run', '--data-dir', dataDir, flow]);
    const runId = await waitForActiveRun(dataDir, startedMarker);
    const beforeClient = await connectClient(dataDir);
    const before = (await beforeClient.journalRead(runId, 1)).entries;
    expect(successfulCompletions(before)).toEqual({ one: 1 });
    expect((await beforeClient.runGet(runId)).steps['two']).toMatchObject({
      type: 'deterministic',
      state: 'running',
    });
    beforeClient.close();
    clients.splice(clients.indexOf(beforeClient), 1);

    console.log(`LIVE_KERNEL kill -9 pid=${firstDaemon.pid} run=${runId} while step=two state=Running`);
    await stopDaemon(firstDaemon, 'SIGKILL');
    daemons.splice(daemons.indexOf(firstDaemon), 1);
    const interrupted = await firstRun;
    expect(interrupted.status).toBe(1);
    expect(interrupted.stderr).toContain('FAILED [protocol_error]');
    writeFileSync(releaseMarker, 'release');
    await startDaemon(dataDir);

    const resumed = invokeCli([
      'resume', '--json', '--data-dir', dataDir, runId,
    ]);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      ok: true,
      command: 'resume',
      runId,
      status: 'completed',
      completionReason: 'success',
    });

    const afterClient = await connectClient(dataDir);
    const after = (await afterClient.journalRead(runId, 1)).entries;
    expect(successfulCompletions(after)).toEqual({ one: 1, two: 1, three: 1 });
    expect(completionReasons(after, 'two')).toEqual(['crashed', 'success']);
  });
});

describe('a relayflow can be scheduled: tick source against live relayflowd', () => {
  // The worked example. The primitive under test is sdk/src/tick-source.ts;
  // what makes this acceptance evidence rather than a plumbing demo is that a
  // real relayflowd holds the dedupe claim and spawns (or refuses to spawn)
  // the runs.
  const TICK_SPEC = () => JSON.parse(
    readFileSync(join(TESTDATA, 'tick-heartbeat.spec.canonical.json'), 'utf8'),
  ) as Parameters<JournalClient['runStart']>[0] & { steps: { id: string; cli?: string }[] };

  function specWithReportCli() {
    const spec = TICK_SPEC();
    for (const step of spec.steps) {
      if (step.id === 'report-slot') step.cli = join(TESTDATA, 'preflight', 'tick-slot-report-cli');
    }
    return spec;
  }

  const MINUTE = 60_000;
  const schedule = { scheduleId: 'heartbeat-1m', intervalMs: MINUTE, epochMs: 0 };

  it('a tick spawns a real run whose step reports the SCHEDULED instant', async () => {
    const dataDir = temporaryDirectory('flows-live-tick-');
    await startDaemon(dataDir);
    const client = await connectClient(dataDir);
    await client.hello('live-tick');
    const worker = new AgentWorker(client, {
      workerId: 'live-tick-worker',
      pins: { workspace: [{ surface: 'repo', revision_id: 'rev-a' }], streams: [] },
    });
    await worker.attach();

    const spec = specWithReportCli();
    const cursor: TickCursor = { lastEmittedSlot: 29_399_999 };
    // Emit 43s into slot 29_400_000. The step must report the slot boundary,
    // not 29_400_000 * MINUTE + 43_000.
    const nowMs = 29_400_000 * MINUTE + 43_000;
    const result = await emitDueTicks(spec, client, { schedule, cursor, nowMs });

    expect(result.emittedSlots).toEqual([29_400_000]);
    expect(result.outcomes[0]).toMatchObject({ matched: true, deduped: false });
    const runId = (result.outcomes[0] as { run: { run_id: string } }).run.run_id;

    expect(await waitForStep(client, runId, 'report-slot', 'done', 20_000)).toMatchObject({
      type: 'agent',
      state: 'done',
    });

    const entries = (await client.journalRead(runId)).entries;
    const completed = entries.find(
      (entry) => isObject(entry) && entry['entry_type'] === 'step.completed'
        && entry['step_id'] === 'report-slot',
    ) as { payload: { output: Record<string, unknown> } } | undefined;
    expect(completed, 'the tick-woken step never completed').toBeDefined();
    // The bound: the run reports the grid instant and its own lag, so a
    // backfilled run can tell it is running for a slot from the past.
    expect(completed!.payload.output).toEqual({
      schedule_id: 'heartbeat-1m',
      slot: 29_400_000,
      scheduled_for_ms: 29_400_000 * MINUTE,
      lag_ms: 43_000,
    });

    await worker.close();
  }, 45_000);

  it('TWO ticks for ONE scheduled instant produce exactly ONE run', async () => {
    // The gate. A test asserting "a tick fired" would pass with a dedupe key
    // derived from wall clock; this one would not.
    const dataDir = temporaryDirectory('flows-live-tick-dedupe-');
    await startDaemon(dataDir);
    const client = await connectClient(dataDir);
    await client.hello('live-tick-dedupe');
    const spec = specWithReportCli();

    // Two pollers, independent cursors, same slot, different emit instants.
    const first = await emitDueTicks(spec, client, {
      schedule,
      cursor: { lastEmittedSlot: 29_399_999 },
      nowMs: 29_400_000 * MINUTE + 1_000,
    });
    const second = await emitDueTicks(spec, client, {
      schedule,
      cursor: { lastEmittedSlot: 29_399_999 },
      nowMs: 29_400_000 * MINUTE + 52_000,
    });

    expect(first.outcomes[0]).toMatchObject({ matched: true, deduped: false });
    expect(second.outcomes[0], 'the kernel spawned a second run for one scheduled instant')
      .toMatchObject({ matched: true, deduped: true, run: null });
    // One run journal on disk, not two.
    expect(runJournals(dataDir)).toHaveLength(1);
  }, 45_000);

  it('a poller RESTART re-emitting a slot does not re-run it', async () => {
    const dataDir = temporaryDirectory('flows-live-tick-restart-');
    await startDaemon(dataDir);
    const client = await connectClient(dataDir);
    await client.hello('live-tick-restart');
    const spec = specWithReportCli();

    const before: TickCursor = { lastEmittedSlot: 29_399_999 };
    await emitDueTicks(spec, client, { schedule, cursor: before, nowMs: 29_400_000 * MINUTE });
    expect(runJournals(dataDir)).toHaveLength(1);

    // Cursor lost. The restarted poller treats the current slot as due.
    const afterRestart: TickCursor = {};
    const replay = await emitDueTicks(spec, client, {
      schedule, cursor: afterRestart, nowMs: 29_400_000 * MINUTE + 30_000,
    });

    expect(replay.emittedSlots).toEqual([29_400_000]);
    expect(replay.outcomes[0]).toMatchObject({ matched: true, deduped: true });
    expect(runJournals(dataDir), 'a restart inside one slot produced a second run').toHaveLength(1);
  }, 45_000);

  it('a MISSED interval is backfilled into its own run, not collapsed into the current one', async () => {
    // The other half of the gate. Dedupe that keyed on the schedule rather
    // than the instant would collapse all four slots into one run.
    const dataDir = temporaryDirectory('flows-live-tick-backfill-');
    await startDaemon(dataDir);
    const client = await connectClient(dataDir);
    await client.hello('live-tick-backfill');
    const spec = specWithReportCli();

    const cursor: TickCursor = { lastEmittedSlot: 29_400_000 };
    const result = await emitDueTicks(spec, client, {
      schedule, cursor, nowMs: 29_400_004 * MINUTE,
    });

    expect(result.emittedSlots).toEqual([29_400_001, 29_400_002, 29_400_003, 29_400_004]);
    const runIds = result.outcomes.map((o) => (o as { run: { run_id: string } }).run.run_id);
    expect(new Set(runIds).size, 'backfilled slots collapsed into fewer runs').toBe(4);
    expect(runJournals(dataDir)).toHaveLength(4);
  }, 45_000);

  it('a tick for a DIFFERENT schedule id does not wake this flow', async () => {
    // Without the trigger's `pattern`, every schedule in the process would
    // wake every tick-triggered flow, since they share one event type.
    const dataDir = temporaryDirectory('flows-live-tick-pattern-');
    await startDaemon(dataDir);
    const client = await connectClient(dataDir);
    await client.hello('live-tick-pattern');
    const spec = specWithReportCli();

    const other = await emitDueTicks(spec, client, {
      schedule: { ...schedule, scheduleId: 'some-other-schedule' },
      cursor: { lastEmittedSlot: 29_399_999 },
      nowMs: 29_400_000 * MINUTE,
    });

    expect(other.outcomes[0]).toMatchObject({ matched: false, deduped: false, run: null });
    expect(runJournals(dataDir)).toHaveLength(0);
  }, 45_000);

  it('journals the declared silence budget, so a dead schedule is not silently zero', async () => {
    // Liveness. `subscription.registered` carries the budget the sweep will
    // actually apply — which is how an operator can tell a declared budget
    // from the engine default. Without a declared budget this flow would
    // inherit 5 minutes without its author ever choosing it.
    const dataDir = temporaryDirectory('flows-live-tick-liveness-');
    await startDaemon(dataDir);
    const client = await connectClient(dataDir);
    await client.hello('live-tick-liveness');
    const spec = specWithReportCli();

    const result = await emitDueTicks(spec, client, {
      schedule, cursor: { lastEmittedSlot: 29_399_999 }, nowMs: 29_400_000 * MINUTE,
    });
    const runId = (result.outcomes[0] as { run: { run_id: string } }).run.run_id;

    const entries = (await client.journalRead(runId)).entries;
    const registered = entries.find(
      (entry) => isObject(entry) && entry['entry_type'] === 'subscription.registered',
    ) as { payload: Record<string, unknown> } | undefined;
    expect(registered, 'no subscription.registered entry — the sweep has nothing to key on')
      .toBeDefined();
    expect(registered!.payload).toMatchObject({
      subscription_id: 'every-minute',
      event_type: 'flows.tick',
      // 180_000 is the flow's declared budget; 300_000 is the engine default.
      // Asserting the declared value is what proves staleAfterMs survives the
      // authoring -> kernel lowering rather than being dropped.
      effective_stale_after_ms: 180_000,
    });
  }, 45_000);
});


function requireExecutable(path: string, source: string, buildCommand: string): void {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error(
      `LIVE_KERNEL_MISSING: ${source} does not name an executable file: ${path}. Build it with: ${buildCommand}`,
    );
  }
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function startDaemon(dataDir: string): Promise<ChildProcess> {
  const daemon = spawn(RELAYFLOWD, ['--data-dir', dataDir, 'serve'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemons.push(daemon);
  const stderr: Buffer[] = [];
  daemon.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  const socket = join(dataDir, 'relayflowd.sock');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(socket) && lstatSync(socket).isSocket()) return daemon;
    if (daemon.exitCode !== null || daemon.signalCode !== null) {
      throw new Error(`relayflowd exited before binding ${socket}: ${Buffer.concat(stderr).toString('utf8')}`);
    }
    await delay(20);
  }
  throw new Error(`relayflowd did not bind ${socket} within 5000ms`);
}

async function stopDaemon(daemon: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (daemon.exitCode !== null || daemon.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => daemon.once('exit', () => resolveExit()));
  daemon.kill(signal);
  await exited;
}

async function connectClient(dataDir: string): Promise<JournalClient> {
  const client = new JournalClient(join(dataDir, 'relayflowd.sock'), { requestTimeoutMs: 5_000 });
  clients.push(client);
  await client.connect();
  return client;
}

function invokeCli(args: string[]) {
  return spawnSync(process.execPath, [BUILT_CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function invokeCliAsync(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [BUILT_CLI, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  daemons.push(child);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolveExit) => child.once('exit', (status) => resolveExit({
    status,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  })));
}

async function waitForActiveRun(dataDir: string, marker: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const runs = join(dataDir, 'runs');
    const journal = existsSync(runs)
      ? readdirSync(runs).find((name) => /^[0-9A-Z]{26}\.sqlite3$/.test(name))
      : undefined;
    if (existsSync(marker) && journal !== undefined) return journal.slice(0, -'.sqlite3'.length);
    await delay(20);
  }
  throw new Error(`run did not reach the marked in-flight step within 5000ms: ${marker}`);
}

async function waitForStep(
  client: JournalClient,
  runId: string,
  stepId: string,
  state: string,
  timeoutMs = 5_000,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const step = (await client.runGet(runId)).steps[stepId];
    if (step?.state === state) return step;
    await delay(20);
  }
  throw new Error(`step ${stepId} did not reach ${state} within ${timeoutMs}ms`);
}

/**
 * Runs the preflight auth contract (`<cli> auth status` exits 0 when
 * usable) against an agent CLI. Reusing the contract rather than
 * checking for `claude` on PATH means the readiness signal is the same
 * fact `flows check` refuses on, so a CLI that preflight would reject
 * cannot silently produce acceptance evidence here.
 */
function probeAnalyzer(cli: string): { ready: boolean; detail: string } {
  if (!existsSync(cli)) return { ready: false, detail: `analyzer CLI does not exist: ${cli}` };
  const identified = spawnSync(cli, ['--relayflows-adapter-v1'], { encoding: 'utf8', timeout: 10_000 });
  if (identified.error !== undefined || identified.status !== 0 || identified.stdout.trim() !== 'relayflows-agent-cli-v1') {
    return { ready: false, detail: `"${cli}" does not identify as relayflows-agent-cli-v1` };
  }
  const probe = spawnSync(cli, ['auth', 'status'], { encoding: 'utf8', timeout: 30_000 });
  if (probe.error !== undefined) {
    return { ready: false, detail: `"${cli} auth status" could not run: ${probe.error.message}` };
  }
  if (probe.status !== 0) {
    return {
      ready: false,
      detail: `"${cli} auth status" exited ${probe.status}: ${probe.stderr.trim()}`,
    };
  }
  return { ready: true, detail: probe.stdout.trim() };
}

function runArtifacts(dataDir: string): string[] {
  return readdirSync(dataDir).filter((name) => name !== 'relayflowd.sock').sort();
}

/**
 * Per-run journal files. `runArtifacts` lists the data dir itself, which is
 * constant regardless of how many runs exist — counting runs needs this.
 */
function runJournals(dataDir: string): string[] {
  const runs = join(dataDir, 'runs');
  return existsSync(runs)
    ? readdirSync(runs).filter((name) => name.endsWith('.sqlite3')).sort()
    : [];
}

function eventOnce<T>(client: JournalClient, event: string): Promise<T> {
  return new Promise<T>((resolveEvent) => client.once(event, (value) => resolveEvent(value as T)));
}

function journalType(entry: unknown): string | undefined {
  return isObject(entry) && typeof entry['entry_type'] === 'string' ? entry['entry_type'] : undefined;
}

function successfulCompletions(entries: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    if (!isObject(entry) || entry['entry_type'] !== 'step.completed') continue;
    const payload = entry['payload'];
    const stepId = entry['step_id'];
    if (!isObject(payload) || payload['completionReason'] !== 'success' || typeof stepId !== 'string') continue;
    counts[stepId] = (counts[stepId] ?? 0) + 1;
  }
  return counts;
}

function completionReasons(entries: unknown[], stepId: string): string[] {
  return entries.flatMap((entry) => {
    if (!isObject(entry) || entry['entry_type'] !== 'step.completed' || entry['step_id'] !== stepId) return [];
    const payload = entry['payload'];
    return isObject(payload) && typeof payload['completionReason'] === 'string'
      ? [payload['completionReason']]
      : [];
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
