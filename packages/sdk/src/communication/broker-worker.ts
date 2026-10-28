import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { JournalClient } from '../journal-client.js';
import type { StepDispatchEvent } from '../protocol.js';
import type { ResolvedKernelAgentStep } from '../resolved-cli-identity.js';
import { isLeaseLost, withWorkerLease } from '../worker-lease.js';
import { isReadInterruptionError } from '../journal-read-policy.js';
import { workerInstruction } from '../worker-input.js';
import { connectLocalBroker, type LocalBroker } from './relay.js';
import { spawnFlowPty, shellQuote } from './pty.js';
import { installBrokerSkills } from './skills.js';
import { openCommunicationTools } from './tools.js';
import type { BrokerInstruction } from './broker-spec.js';

interface Turn {
  id: string;
  completed?: boolean;
  resolve(summary: string): void;
  reject(error: unknown): void;
}
interface Session {
  owner: string;
  broker: LocalBroker;
  pty?: Awaited<ReturnType<typeof spawnFlowPty>>;
  tools?: Awaited<ReturnType<typeof openCommunicationTools>>;
  turn?: Turn;
  unsubscribe?: () => void;
  exited?: string;
  releasing?: Promise<void>;
}

/** Worker-owned live resources. Only journaled agent dispatches start a turn. */
export class BrokerSessions {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly runRoot: string = process.cwd(), private readonly environment?: NodeJS.ProcessEnv) {}

  async close(): Promise<void> {
    const results = await Promise.allSettled([...this.sessions.keys()].map(name => this.release(name)));
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Failed to release flow broker sessions');
  }

  private async release(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (!session) return;
    if (session.releasing) return session.releasing;
    session.releasing = Promise.resolve().then(() => this.releaseSession(name, session));
    try { await session.releasing; }
    finally { session.releasing = undefined; }
  }

  private async releaseSession(name: string, session: Session): Promise<void> {
    session.turn?.reject(new Error('Broker session released'));
    await session.pty?.handle.release('Flow broker session ended', { deleteIdentity: true });
    session.unsubscribe?.();
    try { await session.tools?.close(); }
    finally { try { await session.pty?.close(); } finally { await session.broker.shutdown(); } }
    this.sessions.delete(name);
  }

  async complete(client: JournalClient, dispatch: StepDispatchEvent, instruction: BrokerInstruction, dataDir: string): Promise<void> {
    let output: unknown;
    let reason: 'success' | 'worker_error' | 'timeout' = 'success';
    try {
      output = await withWorkerLease(client, dispatch, signal => this.run(dispatch, instruction, dataDir, signal,
        client.supportsFeature?.('step_secret_scoping') ?? true));
    } catch (error) {
      if (isLeaseLost(error) || isReadInterruptionError(error)) throw error;
      reason = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'worker_error';
      output = { error: error instanceof Error ? error.message : String(error) };
    }
    try {
      await client.stepComplete(dispatch.run_id, dispatch.step_id, dispatch.attempt, dispatch.idempotency_key,
        reason, { output, usage: { tokens_in: 0, tokens_out: 0, dollars_unmetered: true },
          started_pins: dispatch.pins, end_pins: dispatch.pins });
    } catch (error) {
      await this.release(instruction.agentName);
      throw error;
    }
  }

  private async run(dispatch: StepDispatchEvent, instruction: BrokerInstruction, dataDir: string, lease: AbortSignal,
    scopeSecrets = true): Promise<unknown> {
    const { agentName: name, owner } = instruction;
    let session = this.sessions.get(name);
    if (session && session.owner !== owner) throw new Error('Broker agent belongs to another flow');
    if (session?.turn) throw new Error('Broker agent already has work in progress');
    if (instruction.operation === 'release') {
      await this.release(name);
      return { released: true };
    }
    if (session?.exited) {
      await this.release(name);
      throw new Error(`Broker agent ${name}: ${session.exited}`);
    }
    if (instruction.operation === 'message' && !session) {
      throw new Error(`Broker agent ${name} is no longer available; its worker session was lost or released`);
    }
    if (instruction.operation === 'spawn' && session) throw new Error(`Broker agent ${name} already exists`);
    const deadline = AbortSignal.timeout(instruction.timeoutMs);
    const signal = AbortSignal.any([lease, deadline]);
    const turnId = `${dispatch.run_id}:${dispatch.step_id}:${dispatch.attempt}`;
    let succeed!: (summary: string) => void;
    let fail!: (error: unknown) => void;
    const result = new Promise<string>((yes, no) => { succeed = yes; fail = no; });
    void result.catch(() => {});
    let abortWait!: (error: unknown) => void;
    const aborted = new Promise<never>((_, reject) => { abortWait = reject; });
    void aborted.catch(() => {});
    const abort = () => { fail(signal.reason); abortWait(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let succeeded = false;
    try {
      if (instruction.operation === 'spawn') {
        const spec = dispatch.spec as ResolvedKernelAgentStep;
        if (!spec.cli) throw new Error('Broker agent requires a declared CLI');
        const cwd = await realpath(resolve(this.runRoot, instruction.cwd ?? '.'));
        if (!(await stat(cwd)).isDirectory()) throw new Error(`Broker cwd is not a directory: ${cwd}`);
        signal.throwIfAborted();
        await installBrokerSkills(instruction.skills, spec.cli_identity ?? spec.cli, cwd, signal);
        const broker = await connectLocalBroker(this.runRoot);
        session = { owner, broker, turn: { id: turnId, resolve: succeed, reject: fail } };
        this.sessions.set(name, session);
        const current = session;
        session.tools = await openCommunicationTools(async ({ operation, values }) => {
          if (operation !== 'complete' || values.length !== 2 || values[0] !== current.turn?.id || current.turn?.completed) {
            throw new Error('Use complete CURRENT_TURN_ID JSON_SUMMARY; stale and duplicate completions are refused');
          }
          const summary = JSON.stringify(JSON.parse(values[1]!));
          const turn = current.turn;
          turn!.completed = true;
          // Allow the helper's response to flush before releasing the PTY.
          setTimeout(() => turn!.resolve(summary), 100);
          return { completed: true };
        });
        session.unsubscribe = broker.onEvent(event => {
          if (event.name !== name || !['agent_exit', 'agent_exited', 'agent_released'].includes(event.kind)) return;
          current.exited = event.kind;
          if (!current.turn?.completed) current.turn?.reject(new Error(`Broker agent ${name}: ${event.kind}`));
          // An idle exit retires resources immediately. A failed release stays
          // in the map and is retried (and surfaced) on the next call or close.
          if (!current.turn) void this.release(name).catch(() => {});
        });
        broker.connectEvents();
        const task = `${workerInstruction(instruction.task, dispatch)}\n\n${this.completionPrompt(session, turnId)}\n${instruction.keepAlive ? 'Stay alive after completing; later flow steps can send more work.' : 'The flow releases this session after completion.'}`;
        const spawned = spawnFlowPty(broker, { name, cli: spec.cli, identity: spec.cli_identity,
          model: spec.model, task, cwd, dataDir, skipRelayPrompt: false, channels: [instruction.channel], team: `flow-${owner}`,
          environment: this.environment, socket: session.tools.path, token: session.tools.token,
          secrets: spec.secrets, scopeSecrets,
          metadata: { runId: owner, flow: instruction.flow, step: instruction.step } });
        let pty: Awaited<ReturnType<typeof spawnFlowPty>> | undefined;
        try {
          pty = await Promise.race([spawned, aborted]);
          signal.throwIfAborted();
          session.pty = pty;
        } catch (error) {
          // Spawn can resolve after the timeout. The session release below
          // only sees a handle that was stored in time.
          if (session.pty === undefined) void spawned.then(async late => {
            try { await late.handle.release('Flow broker session ended', { deleteIdentity: true }); }
            finally { await late.close(); }
          }, () => {});
          throw error;
        }
        const ready = await Promise.race([session.pty.handle.waitForReady(Math.min(instruction.timeoutMs, 90_000)),
          result.then(() => ({ reason: 'ready' }))]);
        if (ready.reason !== 'ready') throw new Error(`Broker agent did not become ready: ${ready.reason}`);
      } else {
        session!.turn = { id: turnId, resolve: succeed, reject: fail };
        signal.throwIfAborted();
        const receipt = await Promise.race([session!.broker.sendMessage({ to: name, from: `flow-${owner}`,
          text: `${instruction.task}\n\n${this.completionPrompt(session!, turnId)}`, mode: 'wait',
          data: { runId: owner, flow: instruction.flow, step: instruction.step, turnId } }), aborted]);
        if (!receipt.targets.includes(name) || receipt.event_id === 'unsupported_operation') {
          throw new Error(`Broker did not accept the message for ${name}`);
        }
      }
      const summary = await result;
      signal.throwIfAborted();
      succeeded = true;
      return { completionReason: 'success', summary, artifacts: [], agentName: name };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      if (session) session.turn = undefined;
      if (!succeeded || !instruction.keepAlive || session?.exited) await this.release(name);
    }
  }

  private completionPrompt(session: Session, turn: string): string {
    return `Report completion with your shell tool: node ${shellQuote(session.tools!.helperPath)} complete ${shellQuote(turn)} 'JSON_SUMMARY'. The summary must be valid JSON (object, array, or string). Call exactly once for this turn, after the work is finished.`;
  }
}
