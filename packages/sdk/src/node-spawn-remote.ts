import { setTimeout as delay } from 'node:timers/promises';
import {
  NodeSpawnError,
  isRecord,
  normalizeNodeSpawnStatus,
  nonempty,
  terminalStatus,
  validIdempotencyKey,
  type NodeReleaseRequest,
  type NodeSpawnAction,
  type NodeSpawnIdentity,
  type NodeSpawnInvocation,
  type NodeSpawnPort,
  type NodeSpawnReceipt,
  type NodeSpawnRequest,
  type NodeSpawnTarget,
} from './node-spawn.js';

interface RelayAgent { id: string; name: string }
interface RelayNode {
  id?: string; nodeId?: string; name: string; status: string; live?: boolean;
  handlersLive?: boolean; capabilities: Array<{ name: string }>;
  activeAgents?: number; maxAgents?: number;
}
interface RelayInvocation {
  invocationId: string; actionName: string; status: string; handlerNodeId?: string | null;
  dispatchedNodeId?: string | null; output?: Record<string, unknown> | null; error?: string | null;
}
interface PlacementAck extends RelayInvocation {
  node?: RelayNode;
  placement: { node?: string; confirmed: boolean; state: string };
  confirmation?: RelayInvocation;
}

interface PlacementFailure extends Error {
  code?: unknown;
  node?: unknown;
  invocationId?: unknown;
  receipt?: unknown;
}

export interface RemoteNodeSpawnClient {
  agents: { get(name: string): Promise<RelayAgent> };
  nodes: { list(options?: Record<string, unknown>): Promise<RelayNode[]> };
  placement: { spawn(input: Record<string, unknown>): Promise<PlacementAck> };
  commands: { getInvocation(name: string, invocationId: string): Promise<RelayInvocation> };
}

/** Fleet node-spawn adapter backed only by the supported Agent Relay SDK. */
export class RemoteNodeSpawnPort implements NodeSpawnPort {
  constructor(private readonly client: RemoteNodeSpawnClient) {}

  async targets(): Promise<NodeSpawnTarget[]> {
    return (await this.client.nodes.list()).map(node => ({
      id: node.nodeId ?? node.id,
      name: node.name,
      live: node.live ?? node.status === 'online',
      handlersLive: node.handlersLive ?? false,
      capabilities: node.capabilities.map(capability => capability.name),
      activeAgents: node.activeAgents,
      maxAgents: node.maxAgents,
    }));
  }

  async spawn(request: NodeSpawnRequest): Promise<NodeSpawnReceipt> {
    if (!validIdempotencyKey(request.idempotencyKey)) {
      throw new NodeSpawnError('Invalid node-spawn idempotency key', 'spawn_invalid_input');
    }
    const capability = `spawn:${request.harness}`;
    let ack: PlacementAck;
    try {
      ack = await this.client.placement.spawn({
        capability,
        ...(request.node === undefined ? {} : { node: request.node }),
        ...(request.repo === undefined ? {} : { repo: request.repo }),
        ...(request.sandboxOnly === undefined ? {} : { sandboxOnly: request.sandboxOnly }),
        failFast: true,
        confirm: true,
        verifyReady: true,
        confirmTimeoutMs: request.timeoutMs ?? 360_000,
        input: {
          name: request.name,
          task: request.task,
          idempotency_key: request.idempotencyKey,
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.directory === undefined ? {} : { worker_cwd: request.directory }),
        },
      });
    } catch (error) {
      const cleanup = placementFailureCleanup(error, request);
      if (cleanup !== undefined) {
        const failure = error as PlacementFailure;
        const output = isRecord(failure.receipt) && isRecord(failure.receipt.output)
          ? failure.receipt.output : undefined;
        const taskUnconfirmed = output?.warning === 'spawn_task_unconfirmed'
          || (isRecord(output?.warning) && output.warning.code === 'spawn_task_unconfirmed');
        throw new NodeSpawnError(
          error instanceof Error ? error.message : 'Fleet placement failed after dispatch',
          taskUnconfirmed ? 'spawn_task_unconfirmed'
            : nonempty(failure.code) ? failure.code : 'spawn_unconfirmed',
          error,
          cleanup,
        );
      }
      throw error;
    }
    const confirmation = ack.confirmation;
    const output = confirmation?.output;
    const reportedName = nonempty(output?.name) ? output.name : request.name;
    const nodeId = ack.node?.nodeId ?? ack.node?.id
      ?? confirmation?.dispatchedNodeId ?? confirmation?.handlerNodeId ?? undefined;
    let nodeName = ack.node?.name ?? ack.placement.node ?? request.node;
    if (!nodeName && nodeId) {
      nodeName = await this.resolveNodeName(nodeId);
    }
    const taskUnconfirmed = output?.warning === 'spawn_task_unconfirmed'
      || (isRecord(output?.warning) && output.warning.code === 'spawn_task_unconfirmed');
    let cleanup: NodeSpawnIdentity | undefined;
    if (confirmation && output?.spawned === true && nodeName) {
      const outputAgentId = nonempty(output.agent_id) ? output.agent_id : undefined;
      const outputCleanup: NodeSpawnIdentity | undefined = outputAgentId === undefined ? undefined : {
        id: confirmation.invocationId,
        nodeId,
        nodeName,
        name: reportedName,
        agentId: outputAgentId,
      };
      let agent: RelayAgent;
      try {
        agent = await this.resolveAgent(reportedName);
      } catch (error) {
        if (error instanceof NodeSpawnError) {
          throw new NodeSpawnError(error.message, error.code, error.cause ?? error, outputCleanup);
        }
        throw error;
      }
      const exactAgentName = nonempty(agent.name) ? agent.name : reportedName;
      if (!nonempty(agent.id)) {
        throw new NodeSpawnError('The spawned agent identity could not be resolved exactly',
          'spawn_identity_mismatch', undefined, outputCleanup);
      }
      if (exactAgentName !== reportedName || (outputAgentId !== undefined && outputAgentId !== agent.id)) {
        throw new NodeSpawnError('The spawned agent identity could not be resolved exactly',
          'spawn_identity_mismatch', undefined, outputCleanup);
      }
      cleanup = {
        id: confirmation.invocationId,
        nodeId,
        nodeName,
        name: exactAgentName,
        agentId: agent.id,
      };
    }
    if (!confirmation || confirmation.status.toLowerCase() !== 'completed'
      || output?.spawned !== true || output.ready !== true) {
      throw new NodeSpawnError('The fleet node did not prove a ready spawned agent',
        'spawn_unconfirmed', undefined, cleanup);
    }
    if (!cleanup) {
      throw new NodeSpawnError('The spawn result did not identify its exact agent and node', 'spawn_identity_unavailable');
    }
    if (ack.placement.confirmed !== true) {
      throw new NodeSpawnError('The fleet placement was not confirmed',
        'spawn_placement_unconfirmed', undefined, cleanup);
    }
    if (taskUnconfirmed) {
      throw new NodeSpawnError('The fleet node could not confirm initial task delivery',
        'spawn_task_unconfirmed', undefined, cleanup);
    }
    if (reportedName !== request.name) {
      throw new NodeSpawnError('The spawn result named a different agent',
        'spawn_identity_mismatch', undefined, cleanup);
    }
    return {
      ...cleanup,
      action: 'spawn',
      status: 'completed',
      spawned: true,
      ready: true,
      taskUnconfirmed: false,
    };
  }

  async status(action: NodeSpawnAction, invocationId: string): Promise<NodeSpawnInvocation> {
    return mapInvocation(action, await this.client.commands.getInvocation(action, invocationId));
  }

  async release(request: NodeReleaseRequest): Promise<NodeSpawnInvocation> {
    if (!validIdempotencyKey(request.idempotencyKey)) {
      throw new NodeSpawnError('Invalid node-release idempotency key', 'spawn_invalid_input');
    }
    const receipt = request.receipt;
    const ack = await this.client.placement.spawn({
      capability: 'release',
      actionName: 'release',
      node: receipt.nodeName,
      failFast: true,
      confirm: false,
      input: {
        name: receipt.name,
        expected_agent_id: receipt.agentId,
        idempotency_key: request.idempotencyKey,
        reason: request.reason ?? 'Relayflows attempt ended',
      },
    });
    const deadline = Date.now() + 60_000;
    let invocation = mapInvocation('release', ack);
    while (!terminalStatus(invocation.status) && Date.now() < deadline) {
      await delay(500);
      invocation = await this.status('release', ack.invocationId);
    }
    if (invocation.status !== 'completed' || invocation.released !== true) {
      throw new NodeSpawnError('The fleet node did not confirm exact agent release', invocation.errorCode ?? 'release_unconfirmed');
    }
    return invocation;
  }

  private async resolveAgent(name: string): Promise<RelayAgent> {
    let last: unknown;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { return await this.client.agents.get(name); }
      catch (error) { last = error; await delay(250); }
    }
    throw new NodeSpawnError('The ready agent was not visible in the Relay roster', 'spawn_identity_unavailable', last);
  }

  private async resolveNodeName(id: string): Promise<string | undefined> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const nodes = await this.client.nodes.list();
        const name = nodes.find(node => (node.nodeId ?? node.id) === id)?.name;
        if (name) return name;
      } catch { /* Roster convergence is retried within the confirmation budget. */ }
      if (attempt < 9) await delay(250);
    }
    return undefined;
  }
}

function placementFailureCleanup(error: unknown, request: NodeSpawnRequest): NodeSpawnIdentity | undefined {
  if (!(error instanceof Error)) return undefined;
  const failure = error as PlacementFailure;
  if (!isRecord(failure.receipt)) return undefined;
  const receipt = failure.receipt;
  const output = isRecord(receipt.output) ? receipt.output : undefined;
  const invocationId = nonempty(failure.invocationId) ? failure.invocationId
    : nonempty(receipt.invocationId) ? receipt.invocationId : undefined;
  const nodeName = nonempty(failure.node) ? failure.node : request.node;
  const nodeId = nonempty(receipt.dispatchedNodeId) ? receipt.dispatchedNodeId
    : nonempty(receipt.handlerNodeId) ? receipt.handlerNodeId : undefined;
  const agentId = nonempty(output?.agent_id) ? output.agent_id : undefined;
  const name = nonempty(output?.name) ? output.name : request.name;
  if (invocationId === undefined || nodeName === undefined || agentId === undefined
    || output?.spawned !== true || name !== request.name) return undefined;
  return { id: invocationId, nodeId, nodeName, name, agentId };
}

function mapInvocation(action: NodeSpawnAction, value: RelayInvocation): NodeSpawnInvocation {
  const output = value.output;
  const status = value.status.toLowerCase();
  return {
    id: value.invocationId,
    action,
    status: normalizeNodeSpawnStatus(status),
    nodeId: value.dispatchedNodeId ?? value.handlerNodeId ?? undefined,
    name: nonempty(output?.name) ? output.name : undefined,
    spawned: output?.spawned === true,
    ready: output?.ready === true,
    released: output?.released === true,
    taskUnconfirmed: output?.warning === 'spawn_task_unconfirmed'
      || (isRecord(output?.warning) && output.warning.code === 'spawn_task_unconfirmed'),
    errorCode: value.error?.split(':', 1)[0]?.trim() || undefined,
  };
}
