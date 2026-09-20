import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthoredFlowExecutionError } from '../src/authored-flow-error.js';
import * as authoredRoot from '../src/authored-root.js';
import { resumeFlow } from '../src/cli/run.js';
import { socketPathFor } from '../src/daemon-connection.js';
import * as daemonLifecycle from '../src/daemon-lifecycle.js';
import { JournalClient } from '../src/journal-client.js';
import * as localAgent from '../src/local-agent.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';

const RUN_ID = '01M2NDS2RYK3MH6YBSB1CHA9SE';
const SHA = 'a'.repeat(64);
const SURFACE = {
  packageName: '@relayflows/surface', version: '2.0.0',
  packageSha256: SHA, runtimeSha256: SHA,
};

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A daemon whose journal holds one authored root, scripted as this suite needs
 * it: the pinned worker stream, and the input the root was started with.
 *
 * The metadata is built as the real thing — `readAuthoredRootMetadata` parses
 * and validates the `run.spawned` step instruction, so a stubbed
 * `journalRead` exercises the same admission the daemon would. Mocking
 * `authored-root.js` would not reach `cli/run.ts`'s own import of it (see
 * resume-failure.test.ts), and would silently skip the branch under test.
 */
function daemonWithAuthoredRoot(
  root: { localAgentStream?: string; input?: unknown; inputPresent?: boolean } = {},
): { dataDir: string; attached: () => number; resumed: () => number } {
  const dir = mkdtempSync(join(tmpdir(), 'flows-resume-agent-'));
  directories.push(dir);
  let attached = 0;
  let resumed = 0;
  const metadata = {
    kind: 'relayflows.authored-root.v1',
    flowName: 'ship', flowPath: '/work/my flows/ship.flow.ts', sourceSha256: SHA,
    surface: SURFACE, sources: [{ path: '/work/my flows/ship.flow.ts', sourceSha256: SHA, surface: SURFACE }],
    inputPresent: root.inputPresent ?? true,
    ...(root.inputPresent === false ? {} : { input: root.input ?? { plan: 'v2' } }),
    ...(root.localAgentStream === undefined ? {} : { localAgentStream: root.localAgentStream }),
  };
  vi.spyOn(daemonLifecycle, 'ensureDaemon').mockResolvedValue({
    kind: 'attached', socketPath: socketPathFor(dir), connection: null,
  });
  vi.spyOn(JournalClient.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(JournalClient.prototype, 'hello').mockResolvedValue({
    protocol: PROTOCOL_VERSION, server: 'relayflowd-test',
  });
  vi.spyOn(JournalClient.prototype, 'close').mockReturnValue(undefined);
  vi.spyOn(JournalClient.prototype, 'journalRead').mockResolvedValue({
    entries: [{ entry_type: 'run.spawned', payload: { spec: { steps: [{
      id: 'authored-root', type: 'agent', instruction: JSON.stringify(metadata),
      surfaces: { streams: [{ stream: 'authored-root-01H' }] },
    }] } } }],
  } as never);
  vi.spyOn(JournalClient.prototype, 'runResume').mockImplementation(async () => {
    resumed += 1;
    throw new Error('runResume should not be reached by a refused resume');
  });
  vi.spyOn(localAgent, 'attachLocalAgent').mockImplementation(async () => {
    attached += 1;
    throw new Error('attachLocalAgent should not be reached by a refused resume');
  });
  return { dataDir: dir, attached: () => attached, resumed: () => resumed };
}

describe('flows resume --local-agent against an authored root', () => {
  /**
   * The complaint this change answers: the flag was accepted, ignored, and the
   * run parked again with a byte-identical message. It is now a refusal that
   * names what to do instead — and it refuses before anything is attached or
   * journaled, so the run is left exactly as it was.
   */
  it('refuses --local-agent on a run that was started without one, naming the new run to start', async () => {
    const daemon = daemonWithAuthoredRoot({ input: { plan: 'v2' } });

    const result = await resumeFlow(RUN_ID, daemon.dataDir, { localAgent: true });

    expect(result.exitCode).toBe(2);
    expect(result.report.diagnostics.at(-1)).toMatchObject({
      severity: 'refusal', kind: 'local_agent_unavailable',
    });
    const message = result.report.diagnostics.at(-1)!.message;
    expect(message).toContain('--local-agent is admitted at run start; start a new run');
    // Runnable, with the flow path quoted and the root's own input repeated.
    expect(message).toContain(
      `flows run --local-agent '/work/my flows/ship.flow.ts' --input '{"plan":"v2"}'`);
    // Refused means refused: no worker, no journal write.
    expect(daemon.attached()).toBe(0);
    expect(daemon.resumed()).toBe(0);
  });

  it('refuses a resume that drops the flag the root was pinned with', async () => {
    const daemon = daemonWithAuthoredRoot({ localAgentStream: 'local-agent-0a1b2c3d' });

    const result = await resumeFlow(RUN_ID, daemon.dataDir, {});

    expect(result.exitCode).toBe(2);
    expect(result.report.diagnostics.at(-1)).toMatchObject({ kind: 'local_agent_unavailable' });
    // This run IS resumable with the flag, so the remedy is this run, not a
    // new one — the opposite instruction to the case above.
    expect(result.report.diagnostics.at(-1)!.message)
      .toContain(`flows resume --data-dir ${daemon.dataDir} --local-agent ${RUN_ID}`);
    expect(daemon.attached()).toBe(0);
    expect(daemon.resumed()).toBe(0);
  });

  /**
   * The refusal must be a refusal, not a relabelled protocol failure: these
   * used to throw bare `Error`s and surface as `protocol_error` with
   * `RUN <id> unknown`, which blamed the daemon for an invocation mistake.
   */
  it('does not report either refusal as a protocol failure', async () => {
    for (const [root, options] of [
      [{}, { localAgent: true }],
      [{ localAgentStream: 'local-agent-0a1b2c3d' }, {}],
    ] as const) {
      const daemon = daemonWithAuthoredRoot(root);
      const result = await resumeFlow(RUN_ID, daemon.dataDir, options);
      expect(result.report.diagnostics.map(diagnostic => diagnostic.kind))
        .not.toContain('protocol_error');
      expect(JSON.stringify(result.report)).not.toContain('could not complete the resume request');
      vi.restoreAllMocks();
    }
  });

  /**
   * The refusal renders the recorded input back inline, because the journal
   * keeps the document and not the `--input` word that carried it. An input
   * this run may legitimately have been started with — `parseDirectInput`
   * admits a mebibyte — can exceed what `execve` carries in one argument
   * (`MAX_ARG_STRLEN`, 128KiB), and a printed command that dies with
   * `Argument list too long` is no remedy. State the requirement instead.
   */
  it('states the input requirement when the recorded input outgrows a shell argument', async () => {
    const daemon = daemonWithAuthoredRoot({ input: { task: 'x'.repeat(200_000) } });

    const result = await resumeFlow(RUN_ID, daemon.dataDir, { localAgent: true });

    expect(result.exitCode).toBe(2);
    const message = result.report.diagnostics.at(-1)!.message;
    expect(message).toContain('--local-agent is admitted at run start; start a new run');
    expect(message).toContain('bytes of input, more than a shell can carry in one argument');
    // No command rather than an unrunnable one — and the refusal must not
    // itself grow to the size of the input it is describing.
    expect(message).not.toMatch(/--input '/);
    expect(message.length).toBeLessThan(1_000);
  });

  it('states the input requirement when the root recorded no input to repeat', async () => {
    const daemon = daemonWithAuthoredRoot({ inputPresent: false });

    const result = await resumeFlow(RUN_ID, daemon.dataDir, { localAgent: true });

    expect(result.exitCode).toBe(2);
    // Never `--input '{}'`: that would name a different invocation of the flow
    // than the one this run was started with.
    expect(result.report.diagnostics.at(-1)!.message).toContain('no input argument to repeat here');
    expect(result.report.diagnostics.at(-1)!.message).not.toMatch(/--input '/);
  });
});

/**
 * An authored resume that reaches an agent step with no worker to run it.
 * `resumeFlow` used to leave this on `protocolFailure`; even once classified,
 * the park said nothing about the fix, and the fix is not "resume again" —
 * an authored root admits its worker at run start.
 */
function daemonParkingAuthoredResume(parkCause?: 'worker_unavailable' | 'needs_human'): string {
  const dir = mkdtempSync(join(tmpdir(), 'flows-resume-park-'));
  directories.push(dir);
  const metadata = {
    kind: 'relayflows.authored-root.v1',
    flowName: 'ship', flowPath: '/work/ship.flow.ts', sourceSha256: SHA,
    surface: SURFACE, sources: [{ path: '/work/ship.flow.ts', sourceSha256: SHA, surface: SURFACE }],
    inputPresent: true, input: { plan: 'v2' },
  };
  vi.spyOn(daemonLifecycle, 'ensureDaemon').mockResolvedValue({
    kind: 'attached', socketPath: socketPathFor(dir), connection: null,
  });
  vi.spyOn(JournalClient.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(JournalClient.prototype, 'hello').mockResolvedValue({
    protocol: PROTOCOL_VERSION, server: 'relayflowd-test',
  });
  vi.spyOn(JournalClient.prototype, 'close').mockReturnValue(undefined);
  vi.spyOn(JournalClient.prototype, 'journalRead').mockResolvedValue({
    entries: [{ entry_type: 'run.spawned', payload: { spec: { steps: [{
      id: 'authored-root', type: 'agent', instruction: JSON.stringify(metadata),
      surfaces: { streams: [{ stream: 'authored-root-01H' }] },
    }] } } }],
  } as never);
  // The park surfaces as the authored error the child's classification threw.
  // Injected at the driver rather than deeper down: the unit under test is
  // `resumeFlow`'s catch, which inspects only the error — and the real driver
  // would first try to load the pinned source this fixture does not have.
  vi.spyOn(authoredRoot, 'resumeDurableAuthoredFlow').mockImplementation(async () => {
    const error = new AuthoredFlowExecutionError('agent_parked',
      `Run "child-run" parked at step "agent-1" (agent): no worker is attached for step type "agent".`,
      undefined, 'child-run');
    error.parkCause = parkCause;
    throw error;
  });
  return dir;
}

describe('an authored resume that parks for want of a worker', () => {
  it('reports the park with a runnable new run, not another identical resume', async () => {
    const dir = daemonParkingAuthoredResume('worker_unavailable');

    const result = await resumeFlow(RUN_ID, dir, {});

    expect(result.exitCode).toBe(3);
    expect(result.report.status).toBe('parked');
    expect(result.report.parkCause).toBe('worker_unavailable');
    // The child holds the evidence; the root this resume named stays separate.
    expect(result.report.runId).toBe('child-run');
    expect(result.report.rootRunId).toBe(RUN_ID);
    const message = result.report.diagnostics.at(-1)!.message;
    expect(message).toContain(`flows run --local-agent '/work/ship.flow.ts' --input '{"plan":"v2"}'`);
    // Telling someone to resume again is what produced the identical second
    // park this whole change exists to stop.
    expect(message).not.toContain('flows resume');
  });

  it('says nothing about workers when a human has to recover the step', async () => {
    const dir = daemonParkingAuthoredResume('needs_human');

    const result = await resumeFlow(RUN_ID, dir, {});

    expect(result.exitCode).toBe(3);
    expect(result.report.diagnostics.at(-1)!.message).not.toContain('--local-agent');
  });

  it('says nothing when the cause was never established', async () => {
    const dir = daemonParkingAuthoredResume(undefined);

    const result = await resumeFlow(RUN_ID, dir, {});

    expect(result.exitCode).toBe(3);
    // Fail closed: an unclassified park gets no guess.
    expect(result.report.diagnostics.at(-1)!.message).not.toContain('--local-agent');
  });
});
