import { communicationHistory } from './history.js';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { JournalClient } from '../journal-client.js';
import type { StepDispatchEvent } from '../protocol.js';
import type { KernelAgentStep } from '../spec.js';
import { withWorkerLease } from '../worker-lease.js';
import { workerInstruction } from '../worker-input.js';
import { resolveCliModel } from '../cli-adapter.js';
import { channelName, type CommunicationInstruction } from './spec.js';
import { acquireRelayRuntime, type RelayHandle } from './relay.js';
import { CommunicationSession } from './session.js';
import { openCommunicationTools } from './tools.js';

export function requireCommunicationCli(cli: string | undefined): void {
  if (!cli?.trim()) throw new Error('Agent communication requires a declared CLI executable');
}
export async function completeCommunicationDispatch(client: JournalClient, dispatch: StepDispatchEvent,
  instruction: CommunicationInstruction, dataDir: string): Promise<void> {
  const spec = dispatch.spec as KernelAgentStep;
  requireCommunicationCli(spec.cli);
  let output: unknown;
  let completionReason: 'success' | 'worker_error' = 'success';
  try {
    output = await withWorkerLease(client, dispatch, signal => run(client, dispatch, instruction, spec, dataDir, signal));
  } catch (error) {
    completionReason = 'worker_error';
    output = { error: error instanceof Error ? error.message : String(error) };
  }
  await client.stepComplete(dispatch.run_id, dispatch.step_id, dispatch.attempt, dispatch.idempotency_key,
    completionReason, { output, usage: { tokens_in: 0, tokens_out: 0, dollars_unmetered: true },
      started_pins: dispatch.pins, end_pins: dispatch.pins });
}
async function run(client: JournalClient, dispatch: StepDispatchEvent, instruction: CommunicationInstruction,
  spec: KernelAgentStep, dataDir: string, lease: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const signal = AbortSignal.any([lease, controller.signal, AbortSignal.timeout(instruction.timeoutMs)]);
  const relay = await acquireRelayRuntime(dataDir, dispatch.run_id);
  let handle: RelayHandle | undefined;
  let tools: Awaited<ReturnType<typeof openCommunicationTools>> | undefined;
  let pumping: Promise<void> | undefined;
  let receipts = Promise.resolve();
  let unsubscribe: (() => void) | undefined;
  try {
    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const result = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
    // Install the rejection handler before spawn/readiness can fail.
    void result.catch(() => {});
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const session = new CommunicationSession(client, dispatch, instruction, relay, summary => resolve({ summary }), reject);
    tools = await openCommunicationTools(request => session.invoke(request));
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const helper = `node ${quote(tools.helperPath)}`;
    const history = await communicationHistory(client, dispatch, instruction);
    const prompt = `${workerInstruction(instruction.instruction, dispatch)}${history}\n\nYou are flow agent ${dispatch.step_id}. Concurrent peers send messages automatically into your session through Relay. Do not poll for messages. Use your shell/terminal execution tool with ${helper} for flow communication:\n- send PEER STABLE_ID 'message text' (outgoing peers: ${instruction.outgoing.join(', ') || 'none'})\n- ack PEER DELIVERY_SEQ only after processing that message (incoming peers: ${instruction.incoming.join(', ') || 'none'})\n- complete 'summary' when your task and conversation are finished.\nUse these helpers for all peer communication; do not use Relay MCP messaging tools. Stay available for injected messages until the conversation is complete. Use stable semantic message IDs so retries deduplicate sends.`;
    const name = `${relay.prefix}-${dispatch.step_id}`;
    unsubscribe = relay.broker.onEvent(event => {
      if (event.name !== name || !['delivery_injected', 'delivery_verified'].includes(event.kind)) return;
      receipts = receipts.then(async () => {
        await client.streamAppend(dispatch.run_id, channelName(dispatch.step_id, '$receipts'), {
          kind: event.kind, delivery_id: event.delivery_id, verification: event.verification,
          attempt: dispatch.attempt, processing_ack: false,
        });
      });
      void receipts.catch(reject);
    });
    // Relay supplies each CLI's launch flags and injection behavior.
    handle = await relay.broker.spawnPty({ name, cli: basename(spec.cli!).replace(/\.exe$/i, ''), task: prompt, channels: [], skipRelayPrompt: true,
      model: resolveCliModel(spec.cli!, spec.model), cwd: spec.cwd ?? process.cwd(),
      harnessConfig: { runtime: 'pty', command: quote(spec.cli!), args: [],
        cwd: spec.cwd ?? process.cwd(), env: { RELAYFLOW_COMMUNICATION_SOCKET: tools.path },
        delivery: { mode: 'pty-injection', format: 'relay-block' } } });
    const ready = await handle.waitForReady(Math.min(instruction.timeoutMs, 90_000));
    if (ready.reason !== 'ready') throw new Error(`Communication agent did not become ready: ${ready.reason}`);
    pumping = (async () => {
      while (!signal.aborted) { await session.pump(); await delay(200, undefined, { signal }); }
    })();
    void pumping.catch(error => { if (!controller.signal.aborted) reject(error); });
    try { return await result; } finally { signal.removeEventListener('abort', abort); }
  } finally {
    controller.abort();
    unsubscribe?.();
    try { await pumping?.catch(error => { if (error?.name !== 'AbortError') throw error; }); }
    finally {
      try { await receipts; }
      finally { try { await handle?.release('Flow communication attempt ended', { deleteIdentity: true }); }
        finally { try { await tools?.close(); } finally { await relay.close(); } } }
    }
  }
}
