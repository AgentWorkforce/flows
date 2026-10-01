import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { runCli, type RunCliOptions } from '../src/cli.js';
import { addExtensionPlugin } from '../src/cli/add-extension.js';
import { runDirectFlow } from '../src/cli/direct-run.js';
import { startHostedRun } from '../src/cli/hosted-software-garden-run.js';
import { hostedExtensionDispatchFromVerifiedDelivery } from '../src/flow-extension-loader.js';
import { JournalClient, JournalProtocolError } from '../src/journal-client.js';
import { entriesFromDirectory, fakeGithub } from './fake-github.js';

const NATIVE_SHA = '8b33ebab8347514f80d9da5a81206a087f641714';
const REF = `github:AgentWorkforce/flows@${NATIVE_SHA}#extensions/babysitter`;
const entries = entriesFromDirectory(resolve('../..', 'extensions/babysitter'), 'extensions/babysitter');
const roots: string[] = [];

afterAll(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

async function project(): Promise<{ root: string; flowPath: string }> {
  const root = mkdtempSync(join(tmpdir(), 'software-garden-preflight-'));
  roots.push(root);
  const flowPath = join(root, 'software-factory.flow.ts');
  writeFileSync(flowPath, readFileSync(resolve('../..', 'examples/software-factory/software-factory.flow.ts')));
  writeFileSync(join(root, 'flows.json'), JSON.stringify({ cli: 'codex', executors: ['github'] }));
  const io = { stdout: () => {}, stderr: (message: string) => { throw new Error(message); } };
  const github = fakeGithub({
    'AgentWorkforce/flows': { refs: {}, commits: { [NATIVE_SHA]: { entries } } },
  });
  expect(await addExtensionPlugin(REF, io, {
    cwd: root,
    fetch: github.fetch,
    now: () => new Date('2026-09-28T00:00:00Z'),
    versions: { sdk: '2.0.33', surface: '2.0.33' },
  })).toBe(0);
  return { root, flowPath };
}

function input() {
  return {
    event: {
      provider: 'github',
      eventType: 'pull_request.labeled',
      deliveryId: 'delivery-canonical',
    },
    pullRequest: {
      host: 'github',
      owner: 'AgentWorkforce',
      repo: 'flows',
      number: 584,
      headSha: 'a'.repeat(40),
    },
  };
}

function hosted(
  queue: NonNullable<RunCliOptions['hostedSoftwareGardenBabysitter']>['babysitterTurn']['queue'],
): NonNullable<RunCliOptions['hostedSoftwareGardenBabysitter']> {
  return {
    dispatch: hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github',
      eventType: 'pull_request.labeled',
      deliveryId: 'delivery-canonical',
    }),
    babysitterTurn: { queue },
  };
}

async function run(flowPath: string, descriptor: unknown) {
  const stdout: string[] = [];
  let calls = 0;
  const exitCode = await runCli([
    'run', flowPath, '--input', JSON.stringify(descriptor),
    '--data-dir', join(flowPath, '..', '.relayflowd'), '--json', '--no-observer-link',
  ], {
    stdout: line => stdout.push(line),
    stderr: () => {},
  }, {
    hostedSoftwareGardenBabysitter: hosted(async () => {
      calls += 1;
      return { receiptId: `bst_${'4'.repeat(64)}`, status: 'queued' };
    }),
  });
  return { exitCode, report: JSON.parse(stdout.at(-1) ?? '{}'), calls };
}

describe('hosted Software Garden admission boundaries', () => {
  it('retries admission without watch for an older journal daemon', async () => {
    const expected = { run_id: 'run-compat' } as Awaited<ReturnType<JournalClient['runStart']>>;
    const runStart = vi.fn()
      .mockRejectedValueOnce(new JournalProtocolError('bad_request', 'unknown field `watch`'))
      .mockResolvedValueOnce(expected);
    const client = { runStart } as unknown as JournalClient;

    await expect(startHostedRun(
      client,
      {} as Parameters<JournalClient['runStart']>[0],
      'hosted-babysitter:digest',
      true,
    )).resolves.toBe(expected);
    expect(runStart.mock.calls).toEqual([
      [expect.anything(), undefined, 'hosted-babysitter:digest', true],
      [expect.anything(), undefined, 'hosted-babysitter:digest'],
    ]);
  });

  it('refuses malformed verified input before creating a journal run', async () => {
      const installed = await project();
      const malformed = input();
      malformed.pullRequest.number = 0;
      const result = await run(installed.flowPath, malformed);
      expect(result).toMatchObject({ exitCode: 2, report: { ok: false }, calls: 0 });
      expect(result.report.diagnostics).toEqual([
        expect.objectContaining({ severity: 'refusal', kind: 'plugin_event_unroutable' }),
      ]);
      expect(existsSync(join(installed.root, '.relayflowd'))).toBe(false);
  });

  it('refuses a custom in-project journal directory before daemon admission', async () => {
      const installed = await project();
      const stdout: string[] = [];
      let calls = 0;
      const dataDir = join(installed.root, 'state');
      const exitCode = await runCli([
        'run', installed.flowPath, '--input', JSON.stringify(input()),
        '--data-dir', dataDir, '--json', '--no-observer-link',
      ], {
        stdout: line => stdout.push(line),
        stderr: () => {},
      }, {
        hostedSoftwareGardenBabysitter: hosted(async () => {
          calls += 1;
          return { receiptId: 'never', status: 'queued' };
        }),
      });
      expect(exitCode).toBe(2);
      expect(JSON.parse(stdout.at(-1) ?? '{}')).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({
          severity: 'refusal',
          kind: 'plugin_source_invalid',
          message: expect.stringContaining('.relayflowd'),
        })],
      });
      expect(existsSync(dataDir)).toBe(false);
      expect(calls).toBe(0);
  });

  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))(
    'reports a rejected journal completion instead of returning an intermediate run', async () => {
      const installed = await project();
      const rejected = vi.spyOn(JournalClient.prototype, 'stepComplete')
        .mockRejectedValueOnce(new Error('step completion rejected'));
      try {
        const result = await run(installed.flowPath, input());
        expect(result).toMatchObject({
          exitCode: 1,
          report: {
            ok: false,
            diagnostics: [expect.objectContaining({
              severity: 'failure',
              kind: 'protocol_error',
              message: expect.stringContaining('step completion rejected'),
            })],
          },
        });
      } finally {
        rejected.mockRestore();
      }
    },
  );

  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))(
    'drains an in-flight capability before returning a classification cancellation', async () => {
      const installed = await project();
      const dataDir = join(installed.root, '.relayflowd');
      const controller = new AbortController();
      let calls = 0;
      let release!: () => void;
      let started!: () => void;
      const capabilityStarted = new Promise<void>(resolveStarted => { started = resolveStarted; });
      const capabilityRelease = new Promise<void>(resolveRelease => { release = resolveRelease; });
      const authority = hosted(async () => {
        calls += 1;
        started();
        await capabilityRelease;
        return { receiptId: `bst_${'5'.repeat(64)}`, status: 'queued' };
      });

      let settled = false;
      const first = runDirectFlow(
        installed.flowPath,
        JSON.stringify(input()),
        dataDir,
        { hostedSoftwareGardenBabysitter: authority, signal: controller.signal },
      ).finally(() => { settled = true; });
      await capabilityStarted;
      controller.abort(new Error('embedded caller canceled'));
      await delay(100);
      expect(settled).toBe(false);

      release();
      await expect(first).resolves.toMatchObject({
        exitCode: 1,
        report: {
          ok: false,
          diagnostics: [expect.objectContaining({
            kind: 'protocol_error',
            message: expect.stringContaining('canceled'),
          })],
        },
      });
      await expect(runDirectFlow(
        installed.flowPath,
        JSON.stringify(input()),
        dataDir,
        { hostedSoftwareGardenBabysitter: authority },
      )).resolves.toMatchObject({ exitCode: 0, report: { ok: true } });
      expect(calls).toBe(1);
    },
  );
});
