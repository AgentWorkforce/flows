import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { completeCommunicationDispatch } from '../src/communication/worker.js';
import type { JournalClient } from '../src/journal-client.js';
import type { StepDispatchEvent } from '../src/protocol.js';

const state = vi.hoisted(() => ({ environments: [] as Array<Record<string, string>> }));
vi.mock('../src/communication/relay.js', () => ({ acquireRelayRuntime: async () => ({
  prefix: 'flow-test',
  broker: {
    onEvent: () => () => {},
    spawnPty: async (input: { harnessConfig: { env: Record<string, string> } }) => {
      state.environments.push(input.harnessConfig.env);
      return { waitForReady: async () => ({ reason: 'failed' }), release: async () => {} };
    },
  },
  close: async () => {},
}) }));

it('communication worker uses the negotiated capability to scope its broker child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flows-communication-capability-'));
  state.environments.length = 0;
  try {
    for (const scoped of [true, false]) {
      const client = new EventEmitter() as EventEmitter & Record<string, unknown>;
      client.supportsFeature = (name: string) => name === 'step_secret_scoping' && scoped;
      client.stepHeartbeat = async () => ({ lease_deadline_ms: Date.now() + 30_000 });
      client.stepComplete = async () => ({});
      const dispatch = {
        run_id: 'run', step_id: 'agent', step_type: 'agent', attempt: 1,
        idempotency_key: `key-${scoped}`, lease_id: 'lease', lease_deadline_ms: Date.now() + 30_000,
        pins: { workspace: [], streams: [] },
        spec: { cli: 'claude', instruction: 'task' },
      } satisfies StepDispatchEvent;
      await completeCommunicationDispatch(client as unknown as JournalClient, dispatch,
        { type: 'relayflows.communication.v1', instruction: 'task', incoming: [], outgoing: [], timeoutMs: 1000 },
        root, root, {
          ANTHROPIC_API_KEY: 'delivered-provider-key', GH_TOKEN: 'user-repository-secret',
          RELAY_SECRET_ENV_NAMES: '["ANTHROPIC_API_KEY","GH_TOKEN"]',
          RELAY_API_KEY: 'broker-key', RELAYFLOW_V2_SIGNAL_READ_TOKEN: 'private-signal-token',
        });
      const env = state.environments.at(-1)!;
      expect(env.ANTHROPIC_API_KEY).toBe('delivered-provider-key');
      expect(env).not.toHaveProperty('GH_TOKEN');
      expect(env.RELAY_API_KEY).toBe('');
      expect(env).not.toHaveProperty('RELAYFLOW_V2_SIGNAL_READ_TOKEN');
    }
    expect(state.environments).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 10_000);
