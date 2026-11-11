import type { NodeResultDelivery, NodeResultEnvelope } from './node-spawn-result.js';
import type { NodeSpawnReceipt } from './node-spawn.js';

export interface RelayTaskExecution {
  execution_id: string;
  run_id: string;
  step_id: string;
  dispatch_id: string;
  deadline: string;
  node_id?: string;
  node_name: string;
  agent_id: string;
  agent_name: string;
  delivery_id: string;
  message_id: string;
  release_invocation_id?: string;
  accounting?: Record<string, number>;
}

/** Journal evidence for a task executed through native node spawn. */
export interface RelayTaskReceipt {
  invocation_id: string;
  action_name: 'spawn';
  status: 'completed' | 'failed';
  task_execution: RelayTaskExecution;
  output: unknown;
  error: string | null;
  completed_at: string;
}

/** The delivery callback is process-local and must never enter journal output. */
export interface RelayTaskResult {
  receipt: RelayTaskReceipt;
  delivery: NodeResultDelivery;
  spawn: NodeSpawnReceipt;
  envelope: NodeResultEnvelope;
}
