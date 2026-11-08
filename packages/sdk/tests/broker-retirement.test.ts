import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { authoredBroker } from '../src/authored-broker.js';
import { checkAuthoredFlow } from '../src/cli/check.js';
import { checkBrokerEnvironment } from '../src/communication/broker-preflight.js';
import { checkCommunicationEnvironment } from '../src/communication/preflight.js';
import type { FlowSpec } from '../src/spec.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('removes harness-driver from the published dependency contract', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  expect(JSON.stringify({ dependencies: manifest.dependencies, peerDependencies: manifest.peerDependencies,
    optionalDependencies: manifest.optionalDependencies })).not.toContain('@agent-relay/harness-driver');
  expect(manifest.peerDependencies['@agent-relay/sdk']).toBe('>=17.2.1 <18');
});

it('fails legacy retained sessions before creating a journal child run', async () => {
  const run = vi.fn();
  const broker = authoredBroker({ name: 'demo' }, 'root', 'local-worker', run);
  await expect(broker.agent('step', 'worker', { transport: 'broker', task: 'work' }))
    .rejects.toThrow('transport: broker was removed');
  await expect(broker.message('step', 'worker', 'continue')).rejects.toThrow('transport: broker was removed');
  expect(run).not.toHaveBeenCalled();
});

it('has no health-check fallback that can restart or reconnect to a broker', () => {
  expect(() => checkBrokerEnvironment('/workspace')).toThrow('transport: broker was removed');
});

it('refuses a compiled broker spawn through the public check path', () => {
  const root = mkdtempSync(join(tmpdir(), 'broker-retirement-'));
  roots.push(root);
  const cli = join(root, 'codex');
  writeFileSync(cli, '#!/bin/sh\nexit 0\n');
  chmodSync(cli, 0o755);
  const instruction = JSON.stringify({ type: 'relayflows.broker.v1', operation: 'spawn',
    owner: 'owner', flow: 'flow', step: 'step', agentName: 'agent', task: 'work',
    channel: 'default', keepAlive: false, timeoutMs: 1000, skills: [] });
  const flow: FlowSpec = { version: '0.1.0', cli, steps: [
    { id: 'step', type: 'agent', instruction },
  ] };
  const checked = checkAuthoredFlow(flow, join(root, 'flow.yaml'), {
    projectConfig: { directory: root, models: [], executors: [] },
  });
  expect(checked.report.ok).toBe(false);
  expect(checked.report.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: 'refusal', kind: 'probe_failed',
      message: expect.stringContaining('transport: broker was removed') }),
  ]));
  expect(checked.flow).toBeUndefined();
});

it('fails communication admission until the native local caller contract exists', () => {
  expect(() => checkCommunicationEnvironment({ version: '0.1.0', steps: [{ id: 'a', type: 'agent', cli: 'codex',
    instruction: JSON.stringify({ type: 'relayflows.communication.v1', instruction: 'talk', incoming: [],
      outgoing: ['b'], timeoutMs: 1000 }) }] })).toThrow('Native node-spawn communication');
});
