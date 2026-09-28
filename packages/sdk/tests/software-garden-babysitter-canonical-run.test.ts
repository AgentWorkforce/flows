import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { runCli, type RunCliOptions } from '../src/cli.js';
import { addExtensionPlugin } from '../src/cli/add-extension.js';
import { hostedExtensionDispatchFromVerifiedDelivery } from '../src/flow-extension-loader.js';
import { JournalClient } from '../src/journal-client.js';
import { entriesFromDirectory, fakeGithub } from './fake-github.js';

const NATIVE_SHA = '8b33ebab8347514f80d9da5a81206a087f641714';
const REF = `github:AgentWorkforce/flows@${NATIVE_SHA}#extensions/babysitter`;
const DIGEST = 'bdf2187b9a242667d34bbc63e7a744753e146dc8cd6f4047047f2aed28f406ee';
const MANIFEST_SHA256 = '5631a06bbdc8186f4ee0ff955610ead24d001c5197b59fb1fe81fe422c44f226';
const entries = entriesFromDirectory(resolve('../..', 'extensions/babysitter'), 'extensions/babysitter');
const versions = { sdk: '2.0.33', surface: '2.0.33' };
const roots: string[] = [];

afterAll(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function github() {
  return fakeGithub({ 'AgentWorkforce/flows': { refs: {}, commits: { [NATIVE_SHA]: { entries } } } });
}

async function project(install = true) {
  const root = mkdtempSync(join(tmpdir(), 'software-garden-canonical-run-'));
  roots.push(root);
  const flowPath = join(root, 'software-factory.flow.ts');
  writeFileSync(flowPath, readFileSync(resolve('../..', 'examples/software-factory/software-factory.flow.ts')));
  writeFileSync(join(root, 'flows.json'), JSON.stringify({ cli: 'codex', executors: ['github'] }));
  if (install) {
    const io = { stdout: () => {}, stderr: (message: string) => { throw new Error(message); } };
    expect(await addExtensionPlugin(REF, io, {
      cwd: root,
      fetch: github().fetch,
      now: () => new Date('2026-09-28T00:00:00Z'),
      versions,
    })).toBe(0);
  } else {
    writeFileSync(join(root, 'flows.lock.json'), JSON.stringify({ version: 2, plugins: [] }));
  }
  return { root, flowPath };
}

function input(eventType = 'pull_request.labeled', deliveryId = 'delivery-canonical') {
  return {
    event: { provider: 'github', eventType, deliveryId },
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
  eventType: string,
  deliveryId: string,
  queue: NonNullable<RunCliOptions['hostedSoftwareGardenBabysitter']>['babysitterTurn']['queue'],
): NonNullable<RunCliOptions['hostedSoftwareGardenBabysitter']> {
  return {
    dispatch: hostedExtensionDispatchFromVerifiedDelivery({
      provider: 'github',
      eventType,
      deliveryId,
    }),
    babysitterTurn: { queue },
  };
}

async function run(
  flowPath: string,
  descriptor: unknown,
  authority: NonNullable<RunCliOptions['hostedSoftwareGardenBabysitter']>,
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli([
    'run',
    flowPath,
    '--input',
    JSON.stringify(descriptor),
    '--data-dir',
    join(flowPath, '..', '.relayflowd'),
    '--json',
    '--no-observer-link',
  ], {
    stdout: line => stdout.push(line),
    stderr: line => stderr.push(line),
  }, { hostedSoftwareGardenBabysitter: authority });
  return {
    exitCode,
    report: JSON.parse(stdout.at(-1) ?? '{}') as Record<string, unknown>,
    stderr,
  };
}

describe('canonical run dispatches the installed Software Garden Babysitter', () => {
  it('refuses hosted authority on any command surface other than an authored run', async () => {
    const stdout: string[] = [];
    const exitCode = await runCli(['run', 'software-factory.flow.yaml', '--json'], {
      stdout: line => stdout.push(line),
      stderr: () => {},
    }, {
      hostedSoftwareGardenBabysitter: hosted(
        'pull_request.labeled',
        'delivery-canonical',
        async () => ({ receiptId: 'never', status: 'queued' }),
      ),
    });
    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout.at(-1) ?? '{}')).toMatchObject({
      ok: false,
      path: 'software-factory.flow.yaml',
      diagnostics: [expect.objectContaining({
        severity: 'refusal',
        kind: 'invalid_invocation',
      })],
    });
  });

  it('records one deterministic, exact reviewed plugin inventory member', async () => {
    const installed = await project();
    const lock = JSON.parse(readFileSync(join(installed.root, 'flows.lock.json'), 'utf8')) as {
      plugins: unknown[];
    };
    expect(lock.plugins).toEqual([{
      name: 'babysitter',
      version: '0.2.0',
      kind: 'flow-extension',
      source: {
        host: 'github',
        owner: 'AgentWorkforce',
        repo: 'flows',
        sha: NATIVE_SHA,
        path: 'extensions/babysitter',
      },
      digest: DIGEST,
      manifestSha256: MANIFEST_SHA256,
      resolvedAt: '2026-09-28T00:00:00.000Z',
      order: 1,
    }]);
  });

  it.each(['--local-agent', '--agent-capacity', '--allow-human-influenced'])(
    'refuses the unsupported %s flag instead of silently ignoring it', async (flag) => {
      const installed = await project();
      const stdout: string[] = [];
      const args = [
        'run', installed.flowPath, '--input', JSON.stringify(input()), flag,
        ...(flag === '--agent-capacity' ? ['2'] : []), '--json', '--no-observer-link',
      ];
      const exitCode = await runCli(args, {
        stdout: line => stdout.push(line),
        stderr: () => {},
      }, {
        hostedSoftwareGardenBabysitter: hosted(
          'pull_request.labeled',
          'delivery-canonical',
          async () => ({ receiptId: 'never', status: 'queued' }),
        ),
      });
      expect(exitCode).toBe(2);
      expect(JSON.parse(stdout.at(-1) ?? '{}')).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({
          severity: 'refusal',
          kind: 'invalid_invocation',
          message: expect.stringContaining(flag),
        })],
      });
    },
  );

  it.runIf(process.platform === 'linux')(
    'refuses a canonical hosted run with no installed Babysitter before the capability is called', async () => {
      const empty = await project(false);
      let calls = 0;
      const result = await run(empty.flowPath, input(), hosted(
        'pull_request.labeled',
        'delivery-canonical',
        async () => { calls += 1; return { receiptId: 'never', status: 'queued' }; },
      ));
      expect(result).toMatchObject({
        exitCode: 2,
        report: { ok: false, command: 'run', path: empty.flowPath },
      });
      expect(result.report.diagnostics).toEqual([
        expect.objectContaining({ severity: 'refusal', kind: 'plugin_event_unroutable' }),
      ]);
      expect(calls).toBe(0);
    },
  );

  it.runIf(process.platform === 'linux')(
    'refuses installed-store drift before the canonical run calls the capability', async () => {
      const changed = await project();
      appendFileSync(join(changed.root, '.flows/plugins', `babysitter@sha256:${DIGEST}`, 'turn.ts'), '\n// drift\n');
      let calls = 0;
      const result = await run(changed.flowPath, input(), hosted(
        'pull_request.labeled',
        'delivery-canonical',
        async () => { calls += 1; return { receiptId: 'never', status: 'queued' }; },
      ));
      expect(result).toMatchObject({ exitCode: 2, report: { ok: false } });
      expect(result.report.diagnostics).toEqual([
        expect.objectContaining({ severity: 'refusal', kind: 'plugin_source_drift' }),
      ]);
      expect(calls).toBe(0);
    },
  );

  it.runIf(process.platform === 'linux')(
    'refuses an unmatched verified route before the canonical run calls the capability', async () => {
      const installed = await project();
      let calls = 0;
      const result = await run(installed.flowPath, input('push'), hosted(
        'push',
        'delivery-canonical',
        async () => { calls += 1; return { receiptId: 'never', status: 'queued' }; },
      ));
      expect(result).toMatchObject({ exitCode: 2, report: { ok: false } });
      expect(result.report.diagnostics).toEqual([
        expect.objectContaining({ severity: 'refusal', kind: 'plugin_event_unroutable' }),
      ]);
      expect(calls).toBe(0);
    },
  );

  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))(
    'runs the exact matched installed handler through the sandbox from the normal run command', async () => {
      const installed = await project();
      const deliveryId = 'delivery-canonical-e2e';
      let calls = 0;
      const authority = hosted('pull_request.labeled', deliveryId, async (request, received) => {
        calls += 1;
        expect(received.dispatch).toBe(authority.dispatch);
        expect(received.extension).toEqual({
          name: 'babysitter',
          version: '0.2.0',
          ref: REF,
          digest: DIGEST,
        });
        expect(request).toEqual({ delivery: {
          deliveryId,
          provider: 'github',
          eventType: 'pull_request.labeled',
          pullRequest: { owner: 'AgentWorkforce', repository: 'flows', number: 584 },
        } });
        return { receiptId: `bst_${'1'.repeat(64)}`, status: 'queued' };
      });

      const first = await run(installed.flowPath, input('pull_request.labeled', deliveryId), authority);
      expect(first).toMatchObject({
        exitCode: 0,
        report: {
          ok: true,
          command: 'run',
          path: installed.flowPath,
          runId: expect.any(String),
          socketPath: expect.any(String),
          status: 'completed',
          completionReason: 'success',
          completedSteps: 1,
          diagnostics: [],
        },
      });
      const retried = await run(installed.flowPath, input('pull_request.labeled', deliveryId), authority);
      expect(retried).toMatchObject({
        exitCode: 0,
        report: {
          ok: true,
          runId: first.report.runId,
          status: 'completed',
          completionReason: 'success',
          completedSteps: 1,
        },
      });
      expect(calls).toBe(1);
    },
  );

  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))(
    'does not complete the journal while a timed-out capability is still pending', async () => {
      const installed = await project();
      const deliveryId = 'delivery-timeout-pending';
      let calls = 0;
      let release!: () => void;
      let capabilityStarted!: () => void;
      const released = new Promise<void>(resolveReleased => { release = resolveReleased; });
      const started = new Promise<void>(resolveStarted => { capabilityStarted = resolveStarted; });
      const authority = {
        ...hosted('pull_request.labeled', deliveryId, async () => {
          calls += 1;
          capabilityStarted();
          await released;
          return { receiptId: `bst_${'2'.repeat(64)}`, status: 'queued' };
        }),
        // Sandbox startup is part of this deadline. Leave enough time for the
        // capability to begin, then deliberately hold it beyond the deadline.
        timeoutMs: 1_000,
      };

      let settled = false;
      const pending = run(installed.flowPath, input('pull_request.labeled', deliveryId), authority);
      void pending.then(() => { settled = true; }, () => { settled = true; });
      await started;
      await delay(1_050);
      expect(settled).toBe(false);
      expect(calls).toBe(1);

      release();
      const result = await pending;
      expect(result).toMatchObject({
        exitCode: 1,
        report: {
          ok: false,
          status: 'failed',
          completionReason: 'step_failed',
          diagnostics: [expect.objectContaining({
            severity: 'failure',
            kind: 'step_failed',
            message: expect.stringContaining('outcome is in doubt'),
          })],
        },
      });
      const receipts = join(installed.root, '.relayflowd', 'hosted-extension-receipts');
      const afterCompletion = readdirSync(receipts).map(file => readFileSync(join(receipts, file), 'utf8'));
      await delay(50);
      expect(readdirSync(receipts).map(file => readFileSync(join(receipts, file), 'utf8'))).toEqual(afterCompletion);
      expect(calls).toBe(1);
    },
  );

  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))(
    'reuses the durable receipt when an elected effect is replayed before confirmation', async () => {
      const installed = await project();
      const deliveryId = 'delivery-reclaimed-receipt';
      let calls = 0;
      const replay = vi.spyOn(JournalClient.prototype, 'performEffect').mockImplementationOnce(
        async function (effect, perform) {
          const { deduped } = await this.effectRecord(
            effect.runId,
            effect.stepId,
            effect.attempt,
            effect.idempotencyKey,
            effect.surfacePath,
            effect.revisionBefore,
            effect.revisionAfter,
          );
          expect(deduped).toBe(false);
          await perform();
          // Inject the crash boundary: the provider receipt is durable, but
          // effect.confirm has not happened and a reclaimed election reruns
          // the callback. Recovery must consume the receipt, not write twice.
          await perform();
          await this.effectConfirm(
            effect.runId,
            effect.stepId,
            effect.attempt,
            effect.idempotencyKey,
            effect.surfacePath,
          );
          return true;
        },
      );
      try {
        const result = await run(installed.flowPath, input('pull_request.labeled', deliveryId), hosted(
          'pull_request.labeled',
          deliveryId,
          async () => {
            calls += 1;
            return { receiptId: `bst_${'3'.repeat(64)}`, status: 'queued' };
          },
        ));
        expect(result).toMatchObject({
          exitCode: 0,
          report: {
            ok: true,
            status: 'completed',
            completionReason: 'success',
            completedSteps: 1,
          },
        });
        expect(calls).toBe(1);
      } finally {
        replay.mockRestore();
      }
    },
  );

  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))(
    'reports capability denial once as a terminal failure without fallback', async () => {
      const installed = await project();
      const refusal = new Error('live babysit label is absent');
      let calls = 0;
      const result = await run(installed.flowPath, input(), hosted(
        'pull_request.labeled',
        'delivery-canonical',
        async () => { calls += 1; throw refusal; },
      ));
      expect(result).toMatchObject({
        exitCode: 1,
        report: {
          ok: false,
          runId: expect.any(String),
          socketPath: expect.any(String),
          status: 'failed',
          completionReason: 'step_failed',
          diagnostics: [expect.objectContaining({
            severity: 'failure',
            kind: 'step_failed',
            message: refusal.message,
          })],
        },
      });
      expect(calls).toBe(1);
    },
  );

  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))(
    'does not misclassify a post-capability receipt error as a clean refusal', async () => {
      const installed = await project();
      let calls = 0;
      const result = await run(installed.flowPath, input(), hosted(
        'pull_request.labeled',
        'delivery-canonical',
        async () => { calls += 1; return { receiptId: '', status: 'queued' }; },
      ));
      expect(result).toMatchObject({
        exitCode: 1,
        report: {
          ok: false,
          runId: expect.any(String),
          socketPath: expect.any(String),
          status: 'failed',
          completionReason: 'step_failed',
          diagnostics: [expect.objectContaining({
            severity: 'failure',
            kind: 'step_failed',
          })],
        },
      });
      expect(calls).toBe(1);
    },
  );

  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))(
    'fails closed when the capability rejects without an Error value', async () => {
      const installed = await project();
      let calls = 0;
      const result = await run(installed.flowPath, input(), hosted(
        'pull_request.labeled',
        'delivery-canonical',
        async () => { calls += 1; return await Promise.reject(undefined); },
      ));
      expect(result).toMatchObject({
        exitCode: 1,
        report: {
          ok: false,
          runId: expect.any(String),
          status: 'failed',
          completionReason: 'step_failed',
          diagnostics: [expect.objectContaining({
            severity: 'failure',
            kind: 'step_failed',
            message: expect.stringContaining('non-error value'),
          })],
        },
      });
      expect(calls).toBe(1);
    },
  );
});
