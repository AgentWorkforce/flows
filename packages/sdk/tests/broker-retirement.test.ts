import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { authoredBroker } from '../src/authored-broker.js';
import { checkBrokerEnvironment } from '../src/communication/broker-preflight.js';
import { checkCommunicationEnvironment } from '../src/communication/preflight.js';

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

it('fails communication admission until the native local caller contract exists', () => {
  expect(() => checkCommunicationEnvironment({ version: '0.1.0', steps: [{ id: 'a', type: 'agent', cli: 'codex',
    instruction: JSON.stringify({ type: 'relayflows.communication.v1', instruction: 'talk', incoming: [],
      outgoing: ['b'], timeoutMs: 1000 }) }] })).toThrow('Native node-spawn communication');
});
