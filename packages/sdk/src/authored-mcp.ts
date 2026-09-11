import { createHash, randomUUID } from 'node:crypto';
import type { Ctx, Step } from '@relayflows/surface';
import { compileSpec, toKernelSpec } from './compile.js';
import { snapshotJsonValue } from './json-value.js';
import { McpError, openMcpSession } from './mcp-client.js';
import type { McpServerConfig } from './spec.js';
import { SPEC_SCHEMA_VERSION } from './spec.js';
import type { JournalClient } from './journal-client.js';
import type { StepDispatchEvent } from './protocol.js';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';
import type { AuthoredFlowJournalStep } from './authored-flow-executor.js';
import { readCompletedStepOutput } from './authored-step-output.js';

/** Own keys expose precisely the preflight inventory, including prototype-like names. */
export function buildMcpProxy(
  inventory: Readonly<Record<string, readonly string[]>>,
  invoke: (server: string, tool: string, args: unknown, known: boolean) => Step<unknown>,
): Ctx['mcp'] {
  const servers: Record<string, Record<string, (args: unknown) => Step<unknown>>> = Object.create(null);
  for (const [server, names] of Object.entries(inventory)) {
    const tools: Record<string, (args: unknown) => Step<unknown>> = Object.create(null);
    const call = (tool: string, known: boolean) => (args: unknown) =>
      invoke(server, tool, snapshotJsonValue(args, `f.mcp.${server}.${tool} arguments`), known);
    for (const tool of names) tools[tool] = call(tool, true);
    servers[server] = new Proxy(Object.freeze(tools), {
      get(target, key) {
        if (typeof key !== 'string') return undefined;
        if (Object.hasOwn(target, key)) return target[key];
        // Calling a tool outside the inventory still creates an operation,
        // so worker_error is journaled like other runtime failures.
        return call(key, false);
      },
    });
  }
  return Object.freeze(servers);
}

export class McpStepError extends AuthoredFlowExecutionError {
  constructor(readonly diagnostic: string, runId: string) {
    super('step_failed', diagnostic, 'worker_error', runId);
  }
}

/** Helpers lower to an existing agent effect, never a fourth kernel primitive.
 * The MCP receipt lives in step.completed.output: { type, input, output, ... }.
 * A private stream routes the step to this short-lived SDK worker exclusively.
 */
export async function runMcpEffect(
  journal: JournalClient, flowName: string, id: string, server: string, tool: string,
  args: unknown, known: boolean, config: McpServerConfig,
  journalSteps: AuthoredFlowJournalStep[],
): Promise<unknown> {
  const idempotencyKey = `mcp:${server}:${tool}:${createHash('sha256').update(JSON.stringify(args)).digest('hex')}`;
  const surfacePath = `/mcp/${pathPart(server)}/${pathPart(tool)}`;
  const stream = `mcp-worker-${randomUUID()}`;
  const instruction = JSON.stringify({ type: 'mcp', server, tool, input: args });
  const peer = journal.createPeer();
  let diagnostic: string | undefined;
  let settled!: () => void;
  let failed!: (error: unknown) => void;
  const completed = new Promise<void>((resolve, reject) => { settled = resolve; failed = reject; });
  void completed.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let work: Promise<void> | undefined;
  const dispatch = (event: StepDispatchEvent): void => {
    const dispatched = event.spec as { instruction?: string; surfaces?: { streams?: { stream: string }[] } };
    if (event.step_id !== id || event.step_type !== 'agent' || work !== undefined
      || dispatched?.instruction !== instruction
      || !dispatched.surfaces?.streams?.some(pin => pin.stream === stream)) {
      failed(new Error('MCP worker received an unexpected dispatch'));
      return;
    }
    work = execute(event);
    void work.then(settled, failed);
  };
  async function execute(event: StepDispatchEvent): Promise<void> {
    const receipt = { type: 'mcp' as const, server, tool, input: args, idempotencyKey };
    let output: unknown;
    let confirmed = false;
    try {
      if (!known) throw new Error('mcp_unknown_tool');
      confirmed = await peer.performEffect({
        runId: event.run_id, stepId: id, attempt: event.attempt, idempotencyKey: event.idempotency_key,
        surfacePath, revisionBefore: 'pending', revisionAfter: idempotencyKey,
      }, async () => {
        const session = await openMcpSession(config, 10_000);
        try {
          output = await session.callTool(tool, args);
          if (typeof output === 'object' && output !== null && 'isError' in output && output.isError === true) {
            throw new Error('mcp_tool_error');
          }
        } finally { await session.close(); }
      });
      // A confirmed election without its receipt is an interrupted writeback,
      // not a successful result we may invent or a call we may safely repeat.
      if (!confirmed) throw new Error('mcp_result_unavailable');
    } catch (error) {
      if (error instanceof McpError) diagnostic = error.code;
      else if (error instanceof Error && ['mcp_unknown_tool', 'mcp_tool_error', 'mcp_result_unavailable'].includes(error.message)) diagnostic = error.message;
      else throw error; // Journal failures remain fail-closed, never provider errors.
    }
    await peer.stepComplete(event.run_id, id, event.attempt, event.idempotency_key,
      diagnostic === undefined ? 'success' : 'worker_error', {
        output: { ...receipt, output: output ?? null, ...(diagnostic ? { diagnostic } : {}) },
        started_pins: event.pins, end_pins: event.pins,
        ...(diagnostic ? { trajectory_tail: { ...receipt, diagnostic } } : {}),
        effects: confirmed ? [{ surface_path: surfacePath, idempotency_key: event.idempotency_key }] : [],
      });
  }
  try {
    await peer.connect();
    await peer.hello('flows-mcp');
    peer.on('step.dispatch', dispatch);
    await peer.workerAttach(stream, ['agent'], { workspace: [], streams: [{ stream, read_offset: 0 }] }, 1);
    const spec = toKernelSpec(compileSpec({ version: SPEC_SCHEMA_VERSION, name: `${flowName}/${id}`,
      steps: [{ id, type: 'agent', instruction,
        surfaces: { streams: [{ stream }], external: [surfacePath] }, maxIterations: 1 }],
    }));
    timer = setTimeout(() => failed(new Error('MCP worker dispatch deadline exceeded')), 30_000);
    const outcome = await journal.runStart(spec);
    await completed;
    if (diagnostic !== undefined) {
      try { await readCompletedStepOutput(journal, outcome.run_id, id, journalSteps); }
      catch (error) {
        if (!(error instanceof AuthoredFlowExecutionError) || error.code !== 'step_failed') throw error;
        throw new McpStepError(diagnostic, outcome.run_id);
      }
    }
    const receipt = await readCompletedStepOutput(journal, outcome.run_id, id, journalSteps) as { output: unknown };
    return receipt.output;
  } finally {
    clearTimeout(timer);
    peer.off('step.dispatch', dispatch);
    peer.close();
    await work?.catch(() => undefined);
  }
}

function pathPart(value: string): string {
  return encodeURIComponent(value).replaceAll('.', '%2E');
}
