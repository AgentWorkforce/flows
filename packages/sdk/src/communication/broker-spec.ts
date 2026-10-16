import { createHash } from 'node:crypto';
import type { AgentOptions } from '@relayflows/surface';

export const BROKER_TYPE = 'relayflows.broker.v1';
export interface BrokerInstruction {
  type: typeof BROKER_TYPE;
  operation: 'spawn' | 'message' | 'release';
  owner: string;
  flow: string;
  step: string;
  agentName: string;
  task: string;
  cwd?: string;
  skills: string[];
  channel: string;
  keepAlive: boolean;
  timeoutMs: number;
}
export function brokerAgentName(flow: string, step: string, owner: string, id: string): string {
  const label = `${flow}-${step}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+/, '') || 'flow-agent';
  return `${label.slice(0, 46)}-${createHash('sha256').update(JSON.stringify([owner, id])).digest('hex').slice(0, 16)}`;
}
export function brokerOptionsError(options: AgentOptions): string | undefined {
  if (options.transport !== 'broker') {
    if (options.skills !== undefined || options.keepAlive !== undefined || options.channel !== undefined) {
      return 'skills, keepAlive, and channel require transport: broker';
    }
    return;
  }
  if (options.resume !== undefined) return 'broker sessions use f.message instead of resume';
  if (options.keepAlive !== undefined && typeof options.keepAlive !== 'boolean') return 'keepAlive must be a boolean';
  if (options.channel !== undefined && (typeof options.channel !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(options.channel))) return 'channel must be a channel name';
  if (options.skills !== undefined && (!Array.isArray(options.skills)
    || !options.skills.every(skill => typeof skill === 'string' && /^[a-z0-9][a-z0-9-]{0,99}$/.test(skill)))) return 'skills must be canonical skill names';
  if (options.cwd !== undefined && (typeof options.cwd !== 'string' || !options.cwd.trim() || options.cwd.includes('\0'))) return 'cwd must be a nonempty directory path';
}
export function brokerInstruction(raw: unknown): BrokerInstruction | undefined {
  if (typeof raw !== 'string' || !raw.startsWith('{')) return;
  let value: any;
  try { value = JSON.parse(raw); } catch { return; }
  if (value?.type !== BROKER_TYPE) return;
  if (!['spawn', 'message', 'release'].includes(value.operation)
    || !['owner', 'flow', 'step', 'agentName', 'task', 'channel'].every(key => typeof value[key] === 'string' && value[key].length > 0)
    || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 3_600_000
    || !Array.isArray(value.skills) || typeof value.keepAlive !== 'boolean'
    || brokerOptionsError({ ...value, transport: 'broker' })) throw new Error('Invalid broker agent instruction');
  return value;
}
