import type { StepSpec } from '../spec.js';
import { createHash } from 'node:crypto';

export const COMMUNICATION_TYPE = 'relayflows.communication.v1';
export interface CommunicationEdge { from: string; to: string }
export interface CommunicationInstruction {
  type: typeof COMMUNICATION_TYPE;
  instruction: string;
  incoming: string[];
  outgoing: string[];
  timeoutMs: number;
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const name = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v);
export function channelName(from: string, to: string): string {
  return `a2a-${createHash('sha256').update(JSON.stringify([from, to])).digest('hex').slice(0, 24)}`;
}
export function communicationInstruction(instruction: unknown): CommunicationInstruction | undefined {
  if (typeof instruction !== 'string' || !instruction.startsWith('{')) return;
  let value: unknown;
  try { value = JSON.parse(instruction); } catch { return; }
  if (!record(value) || value.type !== COMMUNICATION_TYPE) return;
  if (Object.keys(value).some(k => !['type', 'instruction', 'incoming', 'outgoing', 'timeoutMs'].includes(k))
    || typeof value.instruction !== 'string' || !Array.isArray(value.incoming) || !value.incoming.every(name)
    || !Array.isArray(value.outgoing) || !value.outgoing.every(name)
    || value.incoming.length + value.outgoing.length === 0
    || !Number.isSafeInteger(value.timeoutMs) || Number(value.timeoutMs) < 1 || Number(value.timeoutMs) > 900_000) {
    throw new Error('Invalid agent communication instruction');
  }
  return value as unknown as CommunicationInstruction;
}

/** Authoring sugar only: kernel vocabulary remains agent + declared streams. */
export function expandCommunication(value: unknown): unknown {
  if (!record(value) || !('communication' in value)) return value;
  const { communication, ...flow } = value;
  if (!record(communication) || Object.keys(communication).some(k => !['links', 'timeoutMs'].includes(k))
    || !Array.isArray(communication.links) || !Array.isArray(flow.steps)) {
    throw new Error('communication requires links: [{ from, to }] and optional timeoutMs');
  }
  const timeoutMs = communication.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1 || Number(timeoutMs) > 900_000) {
    throw new Error('communication.timeoutMs must be between 1 and 900000');
  }
  const steps = flow.steps as Record<string, unknown>[];
  const byId = new Map(steps.filter(record).map(step => [step.id, step]));
  const edges: CommunicationEdge[] = [];
  for (const link of communication.links) {
    if (!record(link) || Object.keys(link).some(k => !['from', 'to'].includes(k))
      || !name(link.from) || !name(link.to) || link.from === link.to
      || byId.get(link.from)?.type !== 'agent' || byId.get(link.to)?.type !== 'agent') {
      throw new Error('communication links must name two different agent step ids');
    }
    if (edges.some(e => e.from === link.from && e.to === link.to)) throw new Error('Duplicate communication link');
    edges.push({ from: link.from, to: link.to });
  }
  const ancestors = (id: string, visited = new Set<string>()): Set<string> => {
    if (visited.has(id)) return visited;
    visited.add(id);
    const step = byId.get(id);
    for (const dependency of Array.isArray(step?.dependsOn) ? step.dependsOn : []) {
      if (typeof dependency === 'string') ancestors(dependency, visited);
    }
    return visited;
  };
  for (const edge of edges) {
    if (ancestors(edge.from).has(edge.to) || ancestors(edge.to).has(edge.from)) {
      throw new Error('Communicating agents must be concurrent, not dependency ancestors');
    }
  }
  return { ...flow, steps: steps.map(step => {
    const incoming = edges.filter(e => e.to === step.id).map(e => e.from);
    const outgoing = edges.filter(e => e.from === step.id).map(e => e.to);
    if (!incoming.length && !outgoing.length) return step;
    if (step.transport === 'relay') throw new Error('communication cannot be combined with task transport: relay');
    if (typeof step.instruction !== 'string') throw new Error('Communicating agents require an instruction');
    const surfaces = record(step.surfaces) ? step.surfaces : {};
    const streams = Array.isArray(surfaces.streams) ? surfaces.streams : [];
    return { ...step,
      instruction: JSON.stringify({ type: COMMUNICATION_TYPE, instruction: step.instruction, incoming, outgoing, timeoutMs }),
      // One writer per directed channel; shared writable channels serialize agents.
      surfaces: { ...surfaces, streams: [...streams,
        { stream: channelName(String(step.id), '$receipts') },
        ...outgoing.map(to => ({ stream: channelName(String(step.id), to) }))] },
    };
  }) };
}

/** Check normalized dependencies too, including implicit input bindings. */
export function validateCommunicationTopology(steps: StepSpec[]): void {
  const byId = new Map(steps.map(step => [step.id, step]));
  const communicating = steps.filter(step => step.type === 'agent' && communicationInstruction(step.instruction));
  const depends = (id: string, target: string, visited = new Set<string>()): boolean => {
    if (visited.has(id)) return false;
    visited.add(id);
    return byId.get(id)?.dependsOn?.some(parent => parent === target || depends(parent, target, visited)) ?? false;
  };
  for (const a of communicating) for (const b of communicating) {
    if (a.id === b.id || a.type !== 'agent' || b.type !== 'agent') continue;
    if (depends(a.id, b.id)) throw new Error('Communicating agents must be concurrent, not dependency ancestors');
    if (a.surfaces?.streams?.some(s => b.surfaces?.streams?.some(t => s.stream === t.stream))
      || a.surfaces?.workspace?.some(s => b.surfaces?.workspace?.some(t => s.surface === t.surface))) {
      throw new Error('Communicating agents cannot share writable surfaces: the kernel would serialize them');
    }
  }
}
