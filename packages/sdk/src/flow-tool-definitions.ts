import { parseFlowToolManifest, type FlowToolManifestV1 } from './flow-tool-manifest.js';
import type { FlowToolObjectSchema } from './flow-tool-schema.js';

export interface FlowToolFunctionDefinition {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly parameters: FlowToolObjectSchema;
}
export interface FlowToolMcpDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: FlowToolObjectSchema;
  readonly outputSchema: FlowToolObjectSchema;
}

/** Plain function-call descriptor. Provider-specific strict-mode translation is not implied. */
export function flowToolFunctionDefinition(value: FlowToolManifestV1): FlowToolFunctionDefinition {
  const manifest = parseFlowToolManifest(value);
  return Object.freeze({ type: 'function', name: manifest.name, description: manifest.description, parameters: manifest.inputSchema });
}

/** MCP tools/list metadata only: no server, call handler, authority, or idempotency claim. */
export function flowToolMcpDefinition(value: FlowToolManifestV1): FlowToolMcpDefinition {
  const manifest = parseFlowToolManifest(value);
  return Object.freeze({ name: manifest.name, description: manifest.description, inputSchema: manifest.inputSchema, outputSchema: manifest.resultSchema });
}
