import { canonicalize } from './canonical.js';
import { FlowToolClient, type FlowToolInvocationOptions } from './flow-tool-client.js';
import { flowToolFunctionDefinition } from './flow-tool-definitions.js';
import { FLOW_TOOL_RUN_SCHEMA, type FlowToolCatalogEntryV1 } from './flow-tool-contract.js';
import { parseFlowToolEntry } from './flow-tool-wire.js';

/**
 * One selected, authorized revision; no alternate execution path. Host/session
 * code supplies stable operation metadata separately from model tool arguments.
 * Register only after discovery with this same authenticated client. The server
 * MUST reauthorize; possession of this object is not an authorization token.
 */
export function createFlowToolAdapters(client: FlowToolClient, selected: FlowToolCatalogEntryV1) {
  const entry = parseFlowToolEntry(selected);
  const invoke = (input: unknown, operation: FlowToolInvocationOptions) => client.invoke(entry, input, operation);
  return Object.freeze({
    native: Object.freeze({ definition: flowToolFunctionDefinition(entry.manifest), call: invoke }),
    mcp: Object.freeze({
      // Do not reuse the legacy business-result-only metadata descriptor here:
      // tools/call returns an async run envelope, not the eventual result object.
      definition: Object.freeze({
        name: entry.manifest.name, description: entry.manifest.description,
        inputSchema: entry.manifest.inputSchema, outputSchema: FLOW_TOOL_RUN_SCHEMA,
      }),
      async call(input: unknown, operation: FlowToolInvocationOptions) {
        const run = await invoke(input, operation);
        return {
          structuredContent: Object.freeze({ ...run }),
          content: [{ type: 'text' as const, text: canonicalize(run) }],
        };
      },
    }),
    // Relay action registration can use this schema/handler. An action dispatch
    // acknowledgment is not this return value and must never become completion.
    action: Object.freeze({
      definition: Object.freeze({
        name: entry.manifest.name, description: entry.manifest.description,
        inputSchema: entry.manifest.inputSchema, outputSchema: FLOW_TOOL_RUN_SCHEMA,
      }),
      invoke,
    }),
  });
}
