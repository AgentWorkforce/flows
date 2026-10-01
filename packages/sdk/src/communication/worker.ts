import { communicationHistory } from './history.js';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { JournalClient } from '../journal-client.js';
import type { StepDispatchEvent } from '../protocol.js';
import type { ResolvedKernelAgentStep } from '../resolved-cli-identity.js';
import { withWorkerLease } from '../worker-lease.js';
import { workerInstruction } from '../worker-input.js';
import { resolveCliModel } from '../cli-adapter.js';
import { resolveAgentCwd } from '../agent-cwd.js';
import { channelName, type CommunicationInstruction } from './spec.js';
import { acquireRelayRuntime, type RelayHandle } from './relay.js';
import { CommunicationSession } from './session.js';
import { openCommunicationTools } from './tools.js';
import { agentEnvironment } from './environment.js';

export function requireCommunicationCli(cli: string | undefined): void {
  if (!cli?.trim()) throw new Error('Agent communication requires a declared CLI executable');
}
export async function completeCommunicationDispatch(client: JournalClient, dispatch: StepDispatchEvent,
  instruction: CommunicationInstruction, dataDir: string, runRoot?: string,
  environment?: NodeJS.ProcessEnv): Promise<void> {
  const spec = dispatch.spec as ResolvedKernelAgentStep;
  requireCommunicationCli(spec.cli);
  let output: unknown;
  let completionReason: 'success' | 'worker_error' = 'success';
  try {
    output = await withWorkerLease(client, dispatch, signal =>
      run(client, dispatch, instruction, spec, dataDir, signal, runRoot, environment));
  } catch (error) {
    completionReason = 'worker_error';
    output = { error: error instanceof Error ? error.message : String(error) };
  }
  await client.stepComplete(dispatch.run_id, dispatch.step_id, dispatch.attempt, dispatch.idempotency_key,
    completionReason, { output, usage: { tokens_in: 0, tokens_out: 0, dollars_unmetered: true },
      started_pins: dispatch.pins, end_pins: dispatch.pins });
}
async function run(client: JournalClient, dispatch: StepDispatchEvent, instruction: CommunicationInstruction,
  spec: ResolvedKernelAgentStep, dataDir: string, lease: AbortSignal, runRoot?: string,
  environment?: NodeJS.ProcessEnv): Promise<unknown> {
  // Same contract as the CLI worker: a declared directory is resolved and held
  // inside the same run root the CLI worker measures against, before anything
  // is spawned. Thrown, not reported, because `completeCommunicationDispatch`
  // already turns a throw here into a `worker_error` completion carrying the
  // message.
  const root = runRoot ?? process.cwd();
  const directory = resolveAgentCwd(root, spec.cwd) ?? root;
  const controller = new AbortController();
  const signal = AbortSignal.any([lease, controller.signal, AbortSignal.timeout(instruction.timeoutMs)]);
  const relay = await acquireRelayRuntime(dataDir, dispatch.run_id);
  let handle: RelayHandle | undefined;
  let tools: Awaited<ReturnType<typeof openCommunicationTools>> | undefined;
  let pumping: Promise<void> | undefined;
  let receipts = Promise.resolve();
  let unsubscribe: (() => void) | undefined;
  let cliLinkDirectory: string | undefined;
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
    const cliIdentity = spec.cli_identity ?? spec.cli!;
    const argv0 = basename(cliIdentity);
    let command = spec.cli!;
    if (basename(command) !== argv0) {
      const linkRoot = join(dataDir, 'communication');
      await mkdir(linkRoot, { recursive: true, mode: 0o700 });
      cliLinkDirectory = await mkdtemp(join(linkRoot, 'cli-'));
      command = join(cliLinkDirectory, argv0);
      await symlink(spec.cli!, command, 'file');
    }
    handle = await relay.broker.spawnPty({ name, cli: basename(cliIdentity).replace(/\.exe$/i, ''), task: prompt, channels: [], skipRelayPrompt: true,
      model: resolveCliModel(cliIdentity, spec.model), cwd: directory,
      harnessConfig: { runtime: 'pty', command: quote(command), args: [],
        cwd: directory, env: { ...agentEnvironment(cliIdentity, environment ?? process.env),
          RELAYFLOW_COMMUNICATION_SOCKET: tools.path, RELAYFLOW_COMMUNICATION_TOKEN: tools.token },
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
        finally { try { await tools?.close(); } finally {
          try { await relay.close(); }
          finally { if (cliLinkDirectory) await rm(cliLinkDirectory, { recursive: true, force: true }); }
        } } }
    }
  }
}
