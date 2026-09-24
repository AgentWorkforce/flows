import { accessSync, constants, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalize } from '../src/canonical.js';
import { sealBundle } from '../src/bundle.js';
import { socketPathFor } from '../src/daemon-connection.js';
import { FlowToolClient } from '../src/flow-tool-client.js';
import { createKernelFlowToolControlPlane, FLOW_TOOL_INPUT_PLACEHOLDER } from '../src/flow-tool-kernel.js';
import { createFlowToolManifest } from '../src/flow-tool-manifest.js';
import { JournalClient } from '../src/journal-client.js';

const target = process.env['CARGO_TARGET_DIR']
  ?? join(process.env['RELAYFLOWS_TOOLCHAIN_HOME'] ?? join(homedir(), '.relayflows-toolchain'), 'target');
function locateRelayflowd(): string {
  const direct = join(target, 'debug', 'relayflowd');
  if (existsSync(direct)) return direct;
  return readdirSync(target).map(name => join(target, name, 'debug', 'relayflowd'))
    .filter(path => existsSync(path)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!;
}
const binary = process.env['RELAYFLOWD_BIN'] ?? locateRelayflowd();
const directories: string[] = [];
const daemons: ChildProcess[] = [];
const clients: JournalClient[] = [];

beforeAll(() => accessSync(binary, constants.X_OK));
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const daemon of daemons.splice(0)) {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const stopped = new Promise<void>(resolve => daemon.once('exit', () => resolve()));
      daemon.kill('SIGTERM'); await stopped;
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function daemonAndJournal() {
  const dataDir = mkdtempSync(join(tmpdir(), 'flow-tool-kernel-data-')); directories.push(dataDir);
  const daemon = spawn(binary, ['--data-dir', dataDir, 'serve'], { stdio: ['ignore', 'pipe', 'pipe'] });
  daemons.push(daemon);
  const socket = socketPathFor(dataDir), deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(socket) && lstatSync(socket).isSocket()) {
      const client = new JournalClient(socket, { requestTimeoutMs: 5_000 });
      try { await client.connect(); await client.hello('flow-tool-kernel-live'); clients.push(client); return client; }
      catch { client.close(); }
    }
    await delay(20);
  }
  throw new Error('relayflowd did not become ready');
}

async function deployment() {
  const root = mkdtempSync(join(tmpdir(), 'flow-tool-kernel-bundle-')); directories.push(root);
  const spec = { version: '0.1.0', name: 'echo-json', steps: [{
    id: 'flow-tool-result', type: 'deterministic',
    command: ['/usr/bin/printf', '%s', FLOW_TOOL_INPUT_PLACEHOLDER], depends_on: [], max_iterations: 1,
    retry: { initial_backoff_ms: 0, max_backoff_ms: 0, multiplier: 1, jitter_percent: 0 },
    verification: {}, timeout_ms: 2_000,
  }] };
  const bundlePath = await sealBundle({ name: 'echo-json', out: root, repo: root, env: {
    FLOWS_BUILD_KEY: Buffer.alloc(32, 9).toString('base64'),
  }, warn: () => {}, files: [
    { path: 'spec.canonical.json', data: canonicalize(spec) },
    { path: 'preflight.json', data: canonicalize({ ok: true, diagnostics: [] }) },
    { path: 'lockfile.json', data: canonicalize({ version: 2, plugins: [] }) },
  ] });
  const digest = basename(bundlePath).split('@sha256:')[1]!;
  const entry = {
    manifest: createFlowToolManifest({ name: 'echo_json', description: 'Effect-free kernel conformance tool.',
      flow: { name: 'echo-json', version: '1.0.0', digest: `sha256:${digest}` },
      inputSchema: { type: 'object', properties: { message: { type: 'string', maxLength: 1000 } },
        required: ['message'], additionalProperties: false },
      resultSchema: { type: 'object', properties: { message: { type: 'string', maxLength: 1000 } },
        required: ['message'], additionalProperties: false } }),
    deployment_id: 'echo_deployment', read_only: true as const, effects: [], requires_human: [],
    business_verdicts: ['echoed'], budget: { max_tokens: 1, max_dollars: '0', max_wallclock_ms: 2_000 },
  };
  return { entry, bundlePath, businessVerdict: 'echoed' };
}

describe('kernel-backed Flow Tool control plane', () => {
  it('authenticates, admits once, executes input, and projects terminal journal evidence', async () => {
    const journal = await daemonAndJournal(), deployed = await deployment();
    const transport = await createKernelFlowToolControlPlane({ journal, principal: 'tenant-a/principal-a',
      deployments: [deployed], authorizedDeploymentIds: ['echo_deployment'] });
    const client = new FlowToolClient(transport);
    expect((await client.discover()).tools).toEqual([deployed.entry]);
    const first = await client.invoke(deployed.entry, { message: 'quotes " and $() stay data' }, { idempotencyKey: 'operation-1' });
    expect(first).toMatchObject({ state: 'completed', terminal: { terminal_reason: 'success',
      business_verdict: 'echoed', result: { message: 'quotes " and $() stay data' } } });
    const repeated = await client.invoke(deployed.entry, { message: 'quotes " and $() stay data' }, { idempotencyKey: 'operation-1' });
    expect(repeated.run_id).toBe(first.run_id);
    await expect(client.invoke(deployed.entry, { message: 'different' }, { idempotencyKey: 'operation-1' }))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });
    const entries = (await journal.journalRead(first.run_id, 1, 1000)).entries as Array<{ entry_type: string }>;
    expect(entries.filter(item => item.entry_type === 'run.spawned')).toHaveLength(1);
    expect(entries.map(item => item.entry_type)).toEqual(expect.arrayContaining(['step.completed', 'run.completed']));
    const events = []; for await (const event of client.events(deployed.entry, first)) events.push(event);
    expect(events.map(event => event.type)).toEqual(['run.accepted', 'step.completed', 'run.terminal']);
    expect(await client.evidence(deployed.entry, first)).toEqual(first.terminal?.evidence);
  }, 15_000);

  it('filters discovery and rejects cross-principal observation from journal-bound metadata', async () => {
    const journal = await daemonAndJournal(), deployed = await deployment();
    const allowed = new FlowToolClient(await createKernelFlowToolControlPlane({ journal, principal: 'principal-a',
      deployments: [deployed], authorizedDeploymentIds: ['echo_deployment'] }));
    const run = await allowed.invoke(deployed.entry, { message: 'secret' }, { idempotencyKey: 'operation-2' });
    const reconstructed = new FlowToolClient(await createKernelFlowToolControlPlane({ journal, principal: 'principal-a',
      deployments: [deployed], authorizedDeploymentIds: ['echo_deployment'] }));
    expect((await reconstructed.status(deployed.entry, run)).run_id).toBe(run.run_id);
    const denied = new FlowToolClient(await createKernelFlowToolControlPlane({ journal, principal: 'principal-b',
      deployments: [deployed], authorizedDeploymentIds: ['echo_deployment'] }));
    await expect(denied.status(deployed.entry, run)).rejects.toMatchObject({ code: 'not_authorized' });
    const ungranted = new FlowToolClient(await createKernelFlowToolControlPlane({ journal, principal: 'principal-a',
      deployments: [deployed] }));
    expect((await ungranted.discover()).tools).toEqual([]);
    await expect(ungranted.invoke(deployed.entry, { message: 'secret' }, { idempotencyKey: 'operation-3' }))
      .rejects.toMatchObject({ code: 'not_authorized' });
  }, 15_000);

  it('fails closed during bundle preflight before kernel admission', async () => {
    const journal = await daemonAndJournal(), deployed = await deployment();
    const starts = vi.spyOn(journal, 'runStart');
    const unsafe = { ...deployed, entry: { ...deployed.entry, effects: ['github:read'] } };
    await expect(createKernelFlowToolControlPlane({ journal, principal: 'principal-a', deployments: [unsafe],
      authorizedDeploymentIds: ['echo_deployment'] })).rejects.toMatchObject({ code: 'unsupported' });
    expect(starts).not.toHaveBeenCalled();
  }, 15_000);

  it('revalidates a direct transport invocation before journal admission', async () => {
    const journal = await daemonAndJournal(), deployed = await deployment();
    const starts = vi.spyOn(journal, 'runStart');
    const transport = await createKernelFlowToolControlPlane({ journal, principal: 'principal-a',
      deployments: [deployed], authorizedDeploymentIds: ['echo_deployment'] });
    await expect(transport.request({ method: 'POST', path: '/api/v1/flow-tools/echo_json/invoke',
      idempotencyKey: 'operation-raw', body: {
        api_version: 1, flow: `${deployed.entry.manifest.flow.name}@${deployed.entry.manifest.flow.digest}`,
        deployment_id: deployed.entry.deployment_id, manifest_digest: deployed.entry.manifest.digest,
        input: { message: 42 }, input_digest: `sha256:${'0'.repeat(64)}`, mode: 'async', wait_ms: 0,
      } })).rejects.toMatchObject({ code: 'invalid_contract' });
    expect(starts).not.toHaveBeenCalled();
  }, 15_000);
});
