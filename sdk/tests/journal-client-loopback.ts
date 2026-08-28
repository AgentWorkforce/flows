import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toKernelSpec } from '../src/compile.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import type { FlowSpec, KernelRunSpec } from '../src/spec.js';

export function sockPath(): string {
  return join(tmpdir(), `rf-${randomUUID().slice(0, 8)}.sock`);
}

const HELLO_FLOW: FlowSpec = {
  version: '0.1.0',
  name: 'client-roundtrip',
  steps: [{ id: 'greet', type: 'deterministic', command: 'echo hi' }],
};
export const HELLO_SPEC: KernelRunSpec = toKernelSpec(HELLO_FLOW);

export interface FrameCtx {
  id: string;
  socket: Socket;
  send: (obj: unknown) => void;
}

export interface LoopbackHandlers {
  hello?: (ctx: FrameCtx) => void;
  'run.start'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'run.resume'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'run.get'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'run.watch'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'worker.attach'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'step.heartbeat'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'effect.record'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'effect.confirm'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'step.complete'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'event.emit'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'journal.read'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'stream.append'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'stream.read'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
}

export function startLoopback(path: string, handlers: LoopbackHandlers): Server {
  const server = createServer((socket) => {
    let buffer = '';
    const send = (obj: unknown): void => {
      socket.write(JSON.stringify(obj) + '\n');
    };
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        const req = JSON.parse(line) as { id: string; verb: keyof LoopbackHandlers; params: Record<string, unknown> };
        const handler = handlers[req.verb] as ((ctx: FrameCtx, params: Record<string, unknown>) => void) | undefined;
        if (handler === undefined) {
          send({ id: req.id, ok: false, error: { code: 'unknown_verb', message: req.verb } });
        } else {
          handler({ id: req.id, socket, send }, req.params);
        }
      }
    });
  });
  server.listen(path);
  return server;
}

// A faithful mini-mirror of `RunSpec::parse` (kernel/relayflowd-core/src/spec.rs):
// snake_case keys only, per-type step key sets, flat v0 verification.
export function kernelDialectError(spec: unknown): string | null {
  if (typeof spec !== 'object' || spec === null) return 'spec: expected an object';
  const rootAllowed = new Set(['version', 'name', 'description', 'steps', 'budget']);
  for (const key of Object.keys(spec)) {
    if (!rootAllowed.has(key)) return `unknown field "${key}" at spec`;
  }
  const steps = (spec as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return 'steps: expected an array';
  const common = ['id', 'type', 'depends_on', 'max_iterations', 'retry', 'verification'];
  const byType: Record<string, string[]> = {
    deterministic: ['command', 'timeout_ms'],
    llm: ['prompt', 'model'],
    agent: ['instruction', 'recovery_mode', 'surfaces', 'permissions'],
  };
  for (const [index, step] of steps.entries()) {
    const value = step as Record<string, unknown>;
    const kindFields = byType[value['type'] as string];
    if (kindFields === undefined) return `steps[${index}]: unknown type`;
    const allowed = new Set([...common, ...kindFields]);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) return `unknown field "${key}" at steps[${index}]`;
    }
    if (value['verification'] !== undefined) {
      const gateAllowed = new Set(['output_contains', 'json_schema']);
      for (const key of Object.keys(value['verification'] as Record<string, unknown>)) {
        if (!gateAllowed.has(key)) return `unknown field "${key}" at steps[${index}].verification`;
      }
    }
  }
  return null;
}

export function sendOk(ctx: FrameCtx): void {
  sendResult(ctx, { protocol: PROTOCOL_VERSION, server: 'relayflowd-test' });
}

export function sendResult(ctx: FrameCtx, result: unknown): void {
  ctx.send({ id: ctx.id, ok: true, result });
}
