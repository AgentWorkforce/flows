import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli, type RunCliOptions } from '../src/cli.js';
import { addExtensionPlugin } from '../src/cli/add-extension.js';
import { hostedExtensionDispatchFromVerifiedDelivery } from '../src/flow-extension-loader.js';
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
      const authority = hosted('pull_request.labeled', deliveryId, async (request, received) => {
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

      await expect(run(installed.flowPath, input('pull_request.labeled', deliveryId), authority)).resolves.toMatchObject({
        exitCode: 0,
        stderr: [],
        report: {
          ok: true,
          command: 'run',
          path: installed.flowPath,
          status: 'completed',
          completionReason: 'success',
          completedSteps: 1,
          diagnostics: [],
        },
      });
    },
  );
});
