import { setTimeout as delay } from 'node:timers/promises';
import {
  NodeSpawnError,
  isRecord,
  nonempty,
  terminalStatus,
  type NodeReleaseRequest,
  type NodeSpawnAction,
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
    const capability = `spawn:${request.harness}`;
    const ack = await this.client.placement.spawn({
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
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.directory === undefined ? {} : { worker_cwd: request.directory }),
      },
    });
    const confirmation = ack.confirmation;
    const output = confirmation?.output;
    if (!confirmation || confirmation.status.toLowerCase() !== 'completed'
      || output?.spawned !== true || output.ready !== true) {
      throw new NodeSpawnError('The fleet node did not prove a ready spawned agent', 'spawn_unconfirmed');
    }
    if (output.warning === 'spawn_task_unconfirmed'
      || (isRecord(output.warning) && output.warning.code === 'spawn_task_unconfirmed')) {
      throw new NodeSpawnError('The fleet node could not confirm initial task delivery', 'spawn_task_unconfirmed');
    }
    const reportedName = nonempty(output.name) ? output.name : request.name;
    if (reportedName !== request.name) throw new NodeSpawnError('The spawn result named a different agent', 'spawn_identity_mismatch');
    const agent = await this.resolveAgent(request.name);
    if (agent.name !== request.name || !nonempty(agent.id)
      || (nonempty(output.agent_id) && output.agent_id !== agent.id)) {
      throw new NodeSpawnError('The spawned agent identity could not be resolved exactly', 'spawn_identity_mismatch');
    }
    const nodeName = ack.node?.name ?? ack.placement.node;
    if (!nodeName) throw new NodeSpawnError('The spawn result did not identify its node', 'spawn_node_unconfirmed');
    const nodeId = ack.node?.nodeId ?? ack.node?.id
      ?? confirmation.dispatchedNodeId ?? confirmation.handlerNodeId ?? undefined;
    return {
      id: confirmation.invocationId,
      action: 'spawn',
      status: 'completed',
      nodeId,
      nodeName,
      name: request.name,
      agentId: agent.id,
      spawned: true,
      ready: true,
      taskUnconfirmed: false,
    };
  }

  async status(action: NodeSpawnAction, invocationId: string): Promise<NodeSpawnInvocation> {
    return mapInvocation(action, await this.client.commands.getInvocation(action, invocationId));
  }

  async release(request: NodeReleaseRequest): Promise<NodeSpawnInvocation> {
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
}

function mapInvocation(action: NodeSpawnAction, value: RelayInvocation): NodeSpawnInvocation {
  const output = value.output;
  const status = value.status.toLowerCase();
  return {
    id: value.invocationId,
    action,
    status: normalizeStatus(status),
    nodeId: value.dispatchedNodeId ?? value.handlerNodeId ?? undefined,
    name: nonempty(output?.name) ? output.name : undefined,
    spawned: output?.spawned === true,
    ready: output?.ready === true,
    released: output?.released === true,
    taskUnconfirmed: output?.warning === 'spawn_task_unconfirmed',
    errorCode: value.error?.split(':', 1)[0]?.trim() || undefined,
  };
}

function normalizeStatus(status: string): NodeSpawnInvocation['status'] {
  if (status === 'completed') return 'completed';
  if (terminalStatus(status)) return 'failed';
  if (status === 'running') return 'running';
  if (status === 'dispatched') return 'dispatched';
  return 'pending';
}
