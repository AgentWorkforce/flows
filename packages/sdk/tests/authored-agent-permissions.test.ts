import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flow, type AgentOptions } from '@relayflows/surface';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { JournalClient } from '../src/journal-client.js';
import { sendOk, sendResult, sockPath, startLoopback } from './journal-client-loopback.js';

describe('authored agent permissions', () => {
  let root: string;
  let server: Server | undefined;
  let socket: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'authored-permissions-'));
    const wrapper = join(root, 'adapter.mjs');
    writeFileSync(wrapper, `#!/usr/bin/env node
import { receiveWrapperRequest } from ${JSON.stringify(resolve('../../testdata/preflight/wrapper-session.mjs'))};
if (process.argv[2] === 'auth') process.exit(0);
await receiveWrapperRequest();
process.stdout.write('unused');
`);
    chmodSync(wrapper, 0o755);
    writeFileSync(join(root, 'flows.json'), JSON.stringify({ cli: wrapper, models: ['test-model'] }));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  });

  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (socket) rmSync(socket, { force: true });
    rmSync(root, { recursive: true, force: true });
    server = undefined;
    socket = undefined;
  });

  async function capture(options: AgentOptions, local = false): Promise<Record<string, unknown>> {
    socket = sockPath();
    const submitted: Record<string, unknown>[] = [];
    const steps = new Map<string, Record<string, unknown>>();
    server = startLoopback(socket, {
      hello: ctx => sendOk(ctx),
      'run.start': (ctx, params) => {
        const spec = params.spec as { steps: Record<string, unknown>[] };
        const step = spec.steps[0]!;
        const runId = `permissions-${steps.size}`;
        steps.set(runId, step);
        if (step.type === 'agent') submitted.push(step);
        sendResult(ctx, { run_id: runId, status: 'completed', completion_reason: 'success', completed_steps: 1 });
      },
      'journal.read': (ctx, params) => sendResult(ctx, {
        entries: [{ entry_type: 'step.completed', step_id: steps.get(params.run_id as string)!.id,
          payload: { completionReason: 'success', disposition: 'step_done',
            output: { exit_code: 0, stdout_tail: 'ok', stderr_tail: '' } } }],
      }),
    });
    const client = new JournalClient(socket, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('permissions-test');
    try {
      await executeAuthoredFlow(flow('permissions', async f => {
        await f.agent('writer', options);
        f.done('success');
      }), client, undefined, {
        flowPath: join(root, 'permissions.flow.ts'),
        ...(local ? { localAgentStream: 'test-stream' } : {}),
      });
      expect(submitted).toHaveLength(1);
      return submitted[0]!;
    } finally { client.close(); }
  }

  it.each(['readonly', 'readwrite'] as const)('lowers the full %s declaration', async accessPreset => {
    const step = await capture({ task: 'x', workspace: 'repo', permissions: {
      fileGlobs: ['drafts/**'], networkAllowlist: ['example.com'], accessPreset,
    } });
    expect(step.permissions).toEqual({
      file_globs: ['drafts/**'], network_allowlist: ['example.com'], access_preset: accessPreset,
    });
  });

  it.each([
    [{ fileGlobs: ['drafts/**'] }, { file_globs: ['drafts/**'] }],
    [{ networkAllowlist: [] }, { network_allowlist: [] }],
    [{ accessPreset: 'readonly' }, { access_preset: 'readonly' }],
    [{}, {}],
    [{ fileGlobs: undefined, accessPreset: 'readonly' }, { access_preset: 'readonly' }],
  ])('preserves partial declarations without defaults: %j', async (permissions, expected) => {
    const step = await capture({ task: 'x', permissions } as AgentOptions);
    expect(step.permissions).toEqual(expected);
  });

  it.each([{}, { permissions: undefined }])('preserves absence: %j', async options => {
    const step = await capture({ task: 'x', ...options } as AgentOptions);
    expect(step).not.toHaveProperty('permissions');
  });

  it('accepts permissions without workspace on the local stream path', async () => {
    const step = await capture({ task: 'x', cwd: root, permissions: { accessPreset: 'readonly' } }, true);
    expect(step.permissions).toEqual({ access_preset: 'readonly' });
  });

  it('reads the outer permissions property once', async () => {
    const getter = vi.fn(() => ({ fileGlobs: ['drafts/**'] }));
    const step = await capture({ task: 'x', get permissions() { return getter(); } });
    expect(getter).toHaveBeenCalledTimes(1);
    expect(step.permissions).toEqual({ file_globs: ['drafts/**'] });
  });

  async function refuse(permissions: unknown, message: string, code?: string): Promise<void> {
    const client = new JournalClient('/journal-must-not-be-contacted');
    const submit = vi.spyOn(client, 'runStart');
    await expect(executeAuthoredFlow(flow('invalid-permissions', async f => {
      await f.agent('writer', { task: 'x', permissions } as AgentOptions);
      f.done('success');
    }), client, undefined, { flowPath: join(root, 'permissions.flow.ts') })).rejects.toMatchObject({
      message: expect.stringContaining(message), ...(code ? { code } : {}),
    });
    expect(submit).not.toHaveBeenCalled();
  }

  it.each([null, [], 'readonly', 42, true])('rejects non-object %j', async value => {
    await refuse(value, 'permissions: expected an object', 'agent_cli_unresolved');
  });

  it.each([
    [{ unknown: true }, 'permissions: unknown key "unknown"'],
    [{ file_globs: ['src/**'] }, 'unknown key "file_globs" — did you mean "fileGlobs"?'],
    [{ accessPreset: 'admin' }, 'accessPreset: expected readonly | readwrite'],
    ...['fileGlobs', 'networkAllowlist'].flatMap(field =>
      ['src/**', [1], ['']].map(value => [{ [field]: value }, `${field}: expected an array of strings`])),
  ] as [unknown, string][])('rejects invalid declaration %j', async (value, message) => {
    await refuse(value, message, 'agent_cli_unresolved');
  });

  it('rejects nested accessors without invoking them', async () => {
    const getter = vi.fn(() => ['drafts/**']);
    await refuse({ get fileGlobs() { return getter(); } }, 'accessors are not allowed');
    expect(getter).not.toHaveBeenCalled();
  });
});
