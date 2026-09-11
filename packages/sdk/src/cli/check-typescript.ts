import { dirname, resolve } from 'node:path';
import type { AuthoredFlowDefinition } from '../authored-flow.js';
import { loadAuthoredFlow } from '../authored-flow-loader.js';
import { preflight } from '../preflight.js';
import { SPEC_SCHEMA_VERSION, type McpServerConfig } from '../spec.js';
import { inputFailureReport, readProjectConfig, type CheckReport } from './check.js';

export interface CheckedMcp {
  report: CheckReport;
  servers: Readonly<Record<string, McpServerConfig>>;
  inventory: Readonly<Record<string, readonly string[]>>;
}

export async function checkTypeScriptFlow(path: string): Promise<{ report: CheckReport }> {
  try {
    const { handle, getDefinition } = await loadAuthoredFlow(path);
    return await checkMcpHeader(getDefinition(handle), path);
  } catch (error) {
    return { report: inputFailureReport({ kind: 'invalid_spec', message: (error as Error).message }, path) };
  }
}

/** Check declarations without executing the authored body. */
export async function checkMcpHeader(
  definition: Pick<AuthoredFlowDefinition, 'name' | 'header'>,
  path: string,
): Promise<CheckedMcp> {
  const empty = { servers: Object.freeze({}), inventory: Object.freeze({}) };
  const KNOWN_HEADER_FIELDS = new Set(['tools', 'budget', 'identity', 'memory', 'workspace', 'use']);
  const unsupported = Object.keys(definition.header).filter(key => !KNOWN_HEADER_FIELDS.has(key));
  if (definition.header.tools?.relayfile !== undefined) unsupported.push('tools.relayfile');
  if (unsupported.length) {
    return { ...empty, report: inputFailureReport({ kind: 'invalid_spec',
      message: `flow "${definition.name}" uses unsupported header fields: ${unsupported.join(', ')}` }, path) };
  }
  try {
    const config = readProjectConfig(dirname(resolve(path)));
    const result = await preflight({ version: SPEC_SCHEMA_VERSION, name: definition.name,
      steps: [{ id: 'header', type: 'deterministic', command: ':' }] }, {
      mcpServers: definition.header.tools?.mcp ?? [], mcp: config.mcp,
      probes: { command: () => true, cli: () => { throw new Error('no CLI declared'); }, executor: () => false },
    });
    return {
      servers: config.mcp ?? empty.servers,
      inventory: result.mcpTools ?? empty.inventory,
      report: { ...result, path, projectConfigPath: config.path, gates: [],
        diagnostics: result.diagnostics.filter(d => d.stepId !== 'header') },
    };
  } catch (error) {
    return { ...empty, report: inputFailureReport({ kind: 'config_invalid', message: (error as Error).message }, path) };
  }
}

export class McpPreflightError extends Error {
  constructor(readonly report: CheckReport) {
    super(report.diagnostics.map(d => d.message).join('; '));
  }
}
