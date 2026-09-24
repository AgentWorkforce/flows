import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cloudMirrorRequested, createCloudMirrorSession, mirrorSourceFromPath, MIRROR_ENV,
} from '../src/cli/cloud-mirror-session.js';
import { CloudFlowError } from '../src/cloud-http.js';
import type { RunReport } from '../src/cli/run.js';
import type { CliIo } from '../src/cli.js';

function io(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: line => out.push(line), stderr: line => err.push(line) }, out, err };
}

const okReport: RunReport = { ok: true, command: 'run', runId: '01RUN', resolutions: [], diagnostics: [] };

function registration() {
  return {
    runId: 'cloud-run',
    token: 'cld_at_x',
    callbackToken: 'cb',
    runUrl: 'https://agentrelay.com/cloud/dashboard/workflow/cloud-run/runner',
  };
}

describe('cloudMirrorRequested', () => {
  it('is off unless this shell actually asked for the dashboard', () => {
    // Only an affirmative counts. Reading a stray value as consent would
    // upload someone's runs on the strength of an unrelated variable.
    for (const value of ['1', 'true', 'on', 'yes', 'TRUE']) {
      expect(cloudMirrorRequested({ [MIRROR_ENV]: value })).toBe(true);
    }
    expect(cloudMirrorRequested({})).toBe(false);
    for (const value of ['', '0', 'false', 'off', 'no', 'maybe', 'please']) {
      expect(cloudMirrorRequested({ [MIRROR_ENV]: value })).toBe(false);
    }
  });
});

describe('createCloudMirrorSession', () => {
  it('registers once the run id exists, prints the page, and starts on that run', async () => {
    const { io: cli, err } = io();
    const register = vi.fn(async () => registration());
    const mirror = { runId: 'cloud-run', runUrl: registration().runUrl, start: vi.fn(), event: vi.fn(), finish: vi.fn(async () => {}) };
    const session = createCloudMirrorSession({
      source: async () => ({ workflow: 'name: demo\n', fileType: 'yaml' }),
      dataDir: '/data',
      log: () => ['RUN 01RUN'],
      requested: 'flag',
    }, cli, {}, { register, createMirror: vi.fn(() => mirror) });

    session.onRunStarted({ runId: '01RUN' });
    await session.finish(okReport);

    expect(register).toHaveBeenCalledOnce();
    expect(mirror.start).toHaveBeenCalledWith('01RUN');
    expect(err[0]).toContain(`Dashboard: ${registration().runUrl}`);
    expect(mirror.finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', log: ['RUN 01RUN'] }));
  });

  it('registers exactly once however many entries arrive', async () => {
    const { io: cli } = io();
    const register = vi.fn(async () => registration());
    const mirror = { runId: 'cloud-run', runUrl: 'u', start: vi.fn(), event: vi.fn(), finish: vi.fn(async () => {}) };
    const session = createCloudMirrorSession({
      source: async () => ({ workflow: 'name: demo\n', fileType: 'yaml' }),
      dataDir: '/data',
      log: () => [],
      requested: 'flag',
    }, cli, {}, { register, createMirror: vi.fn(() => mirror) });

    session.onJournalEntry({ run_id: '01RUN' });
    session.onJournalEntry({ run_id: '01RUN' });
    session.onRunStarted({ runId: '01RUN' });
    await session.finish(okReport);

    expect(register).toHaveBeenCalledOnce();
    expect(mirror.start).toHaveBeenCalledOnce();
  });

  it('hands back the Cloud run id, so a script has a handle on the mirrored run', async () => {
    const { io: cli, err } = io();
    const mirror = { runId: 'cloud-run', runUrl: registration().runUrl, start: vi.fn(), event: vi.fn(), finish: vi.fn(async () => {}) };
    const session = createCloudMirrorSession({
      source: async () => ({ workflow: 'name: demo\n', fileType: 'yaml' }),
      dataDir: '/data',
      log: () => [],
      requested: 'flag',
    }, cli, {}, { register: vi.fn(async () => registration()), createMirror: vi.fn(() => mirror) });

    // Nothing is known before the run starts, and asking does not start one.
    await expect(session.receipt()).resolves.toBeUndefined();

    session.onRunStarted({ runId: '01RUN' });
    await expect(session.receipt()).resolves.toEqual({
      cloudRunId: 'cloud-run', dashboardUrl: registration().runUrl,
    });
    // The report's own `runId` is the journal's; every hosted read verb takes
    // Cloud's, so the terminal line names it too rather than burying it in a URL.
    expect(err[0]).toContain('flows status --cloud --watch cloud-run');
  });

  it('says the run stays local when there is no Cloud login, and finishes cleanly', async () => {
    const { io: cli, err } = io();
    const missing = new CloudFlowError('configuration', 'Set FLOWS_CLOUD_TOKEN …');
    missing.reason = 'auth_missing';
    const session = createCloudMirrorSession({
      source: async () => ({ workflow: 'name: demo\n', fileType: 'yaml' }),
      dataDir: '/data',
      log: () => [],
      requested: 'flag',
    }, cli, {}, { register: vi.fn(async () => { throw missing; }) });

    session.onRunStarted({ runId: '01RUN' });
    await expect(session.finish(okReport)).resolves.toBeUndefined();

    expect(err).toHaveLength(1);
    // The run asked for the dashboard and did not get it: the line names what
    // asked, and both ways to stop it being a surprise next time.
    expect(err[0]).toContain('--cloud-mirror asked for the Cloud dashboard');
    expect(err[0]).toContain('no Cloud login, so this run stays local');
    expect(err[0]).toContain('agent-relay cloud login');
  });

  it('names a deployment that does not serve the route yet, without blaming the run', async () => {
    const { io: cli, err } = io();
    const session = createCloudMirrorSession({
      source: async () => ({ workflow: 'name: demo\n', fileType: 'yaml' }),
      dataDir: '/data',
      log: () => [],
      requested: 'flag',
    }, cli, {}, {
      register: vi.fn(async () => { throw new CloudFlowError('http_error', 'HTTP 404', 404); }),
    });

    session.onRunStarted({ runId: '01RUN' });
    await session.finish(okReport);

    expect(err[0]).toContain('does not accept local runs');
    expect(err[0]).toContain('the run itself is unaffected');
  });

  it('never registers a run that was refused before it started', async () => {
    const { io: cli } = io();
    const register = vi.fn(async () => registration());
    const session = createCloudMirrorSession({
      source: async () => ({ workflow: 'name: demo\n', fileType: 'yaml' }),
      dataDir: '/data',
      log: () => [],
      requested: 'flag',
    }, cli, {}, { register });

    // No run id ever arrived: `flows run` refused the flow at check time.
    await session.finish({ ...okReport, ok: false, runId: undefined });

    expect(register).not.toHaveBeenCalled();
  });

  /**
   * Cloud reconciles a v2 run's reported status against the report it carries:
   * a `completed` callback whose result lacks `ok`, `status`,
   * `completionReason` or `runId` is recorded as `failed`. The first version of
   * this mirror sent a status with no report, and every finished local run
   * showed up red on the dashboard.
   */
  it('carries the four fields Cloud reconciles a successful v2 run against', async () => {
    const { io: cli } = io();
    const mirror = { runId: 'cloud-run', runUrl: 'u', start: vi.fn(), event: vi.fn(), finish: vi.fn(async () => {}) };
    const session = createCloudMirrorSession({
      source: async () => ({ workflow: 'name: demo\n', fileType: 'yaml' }),
      dataDir: '/data',
      log: () => [],
      requested: 'flag',
    }, cli, {}, { register: vi.fn(async () => registration()), createMirror: vi.fn(() => mirror) });

    session.onRunStarted({ runId: '01RUN' });
    await session.finish({
      ok: true,
      command: 'run',
      runId: '01RUN',
      status: 'completed',
      completionReason: 'success',
      completedSteps: 2,
      resolutions: [],
      diagnostics: [],
    });

    const outcome = mirror.finish.mock.calls[0]![0] as { status: string; result: Record<string, unknown> };
    expect(outcome.status).toBe('completed');
    expect(outcome.result).toMatchObject({
      ok: true, status: 'completed', completionReason: 'success', runId: '01RUN', completedSteps: 2,
    });
  });

  it('bounds the diagnostics the report carries, and says how many it dropped', async () => {
    const { io: cli } = io();
    const mirror = { runId: 'cloud-run', runUrl: 'u', start: vi.fn(), event: vi.fn(), finish: vi.fn(async () => {}) };
    const session = createCloudMirrorSession({
      source: async () => ({ workflow: 'name: demo\n', fileType: 'yaml' }),
      dataDir: '/data',
      log: () => [],
      requested: 'flag',
    }, cli, {}, { register: vi.fn(async () => registration()), createMirror: vi.fn(() => mirror) });

    session.onRunStarted({ runId: '01RUN' });
    await session.finish({
      ok: false,
      command: 'run',
      runId: '01RUN',
      resolutions: [],
      diagnostics: Array.from({ length: 25 }, (_unused, index) => ({
        severity: 'failure' as const,
        kind: 'step_failed' as const,
        message: `${index}:${'x'.repeat(5_000)}`,
      })),
    });

    const result = (mirror.finish.mock.calls[0]![0] as { result: Record<string, unknown> }).result;
    const diagnostics = result.diagnostics as Array<{ message: string }>;
    expect(diagnostics).toHaveLength(20);
    expect(result.diagnosticsOmitted).toBe(5);
    // The report is stored whole, and a diagnostic is the one unbounded field.
    expect(diagnostics.every(entry => [...entry.message].length <= 2_000)).toBe(true);
  });

  it('reports a park as a failed run carrying its completion reason', async () => {
    const { io: cli } = io();
    const mirror = { runId: 'cloud-run', runUrl: 'u', start: vi.fn(), event: vi.fn(), finish: vi.fn(async () => {}) };
    const session = createCloudMirrorSession({
      source: async () => ({ workflow: 'name: demo\n', fileType: 'yaml' }),
      dataDir: '/data',
      log: () => [],
      requested: 'flag',
    }, cli, {}, { register: vi.fn(async () => registration()), createMirror: vi.fn(() => mirror) });

    session.onRunStarted({ runId: '01RUN' });
    await session.finish({
      ok: false,
      command: 'run',
      runId: '01RUN',
      status: 'parked',
      completionReason: 'needs_human',
      resolutions: [],
      diagnostics: [{ severity: 'parked', kind: 'needs_human', message: 'waiting on a human' }],
    });

    expect(mirror.finish).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed', completionReason: 'needs_human',
    }));
  });
});

describe('mirrorSourceFromPath', () => {
  it('sends a declarative flow as the bytes on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirror-source-'));
    const path = join(dir, 'flow.yaml');
    await writeFile(path, 'name: demo\nsteps: []\n');
    await expect(mirrorSourceFromPath(path, undefined, '/data')('01RUN')).resolves.toEqual({
      workflow: 'name: demo\nsteps: []\n', fileType: 'yaml',
    });
  });

  it('sends an authored flow with the input it was invoked with', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mirror-source-'));
    const path = join(dir, 'review.flow.ts');
    await writeFile(path, 'export default flow("review", () => {});\n');
    await expect(mirrorSourceFromPath(path, '{"pr":7}', '/data')('01RUN')).resolves.toEqual({
      workflow: 'export default flow("review", () => {});\n', fileType: 'ts', inputs: { pr: 7 },
    });
  });
});
