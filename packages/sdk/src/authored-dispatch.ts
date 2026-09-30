import type { DispatchResult } from '@relayflows/surface';
import type { FlowHandle } from './authored-flow.js';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';
import type { LoadedAuthoredFlowNode } from './authored-flow-loader.js';
import { flowRequirements, type RequirementsFlowDefinition } from './flow-requirements.js';

export const MAX_DISPATCH_DEPTH = 3;

/** Resolve one attenuated direct child from the statically loaded `use` graph. */
export function resolveDispatchChild(options: {
  readonly handle: FlowHandle;
  readonly definition: RequirementsFlowDefinition & { readonly name: string };
  readonly graph?: readonly LoadedAuthoredFlowNode[];
  readonly flowName: string;
  readonly depth: number;
}): LoadedAuthoredFlowNode {
  if (typeof options.flowName !== 'string' || options.flowName.trim() === '') {
    throw new AuthoredFlowExecutionError('dispatch_invalid', 'f.dispatch requires a non-empty declared child flow name');
  }
  if (options.depth >= MAX_DISPATCH_DEPTH) {
    throw new AuthoredFlowExecutionError(
      'dispatch_depth_exceeded',
      `f.dispatch depth exceeds ${MAX_DISPATCH_DEPTH}; flatten the flow tree or move work into the current child`,
    );
  }
  const current = options.graph?.find(node => node.handle === options.handle);
  const direct = current?.use.map(path => options.graph!.find(node => node.path === path)) ?? [];
  const matches = direct.filter((node): node is LoadedAuthoredFlowNode =>
    node !== undefined && node.getDefinition(node.handle).name === options.flowName);
  if (matches.length !== 1) {
    const declared = direct.filter((node): node is LoadedAuthoredFlowNode => node !== undefined)
      .map(node => node.getDefinition(node.handle).name).sort();
    throw new AuthoredFlowExecutionError(
      matches.length > 1 ? 'dispatch_invalid' : 'dispatch_unknown',
      `flow "${options.definition.name}" cannot dispatch ${JSON.stringify(options.flowName)}; direct use children: ${declared.length === 0 ? '(none)' : declared.join(', ')}`,
    );
  }
  const child = matches[0]!;
  const childDefinition = child.getDefinition(child.handle);
  assertChildCapabilities(options.definition, childDefinition);
  if (childDefinition.header.budget !== undefined) {
    throw new AuthoredFlowExecutionError(
      'dispatch_invalid',
      `child flow "${childDefinition.name}" declares its own budget; put the run-tree ceiling on "${options.definition.name}" until nested budget intersection ships`,
    );
  }
  return child;
}

export function parseDispatchReceipt(value: string, step: string): DispatchResult {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch {
    throw new AuthoredFlowExecutionError('journal_protocol_violation', `dispatch step "${step}" recorded invalid JSON`);
  }
  const receipt = parsed as Partial<DispatchResult> | null;
  if (typeof receipt !== 'object' || receipt === null || typeof receipt.name !== 'string'
    || receipt.completionReason !== 'success'
    || (receipt.completionDetail !== undefined && typeof receipt.completionDetail !== 'string')) {
    throw new AuthoredFlowExecutionError('journal_protocol_violation', `dispatch step "${step}" recorded an invalid child receipt`);
  }
  return {
    name: receipt.name,
    completionReason: 'success',
    ...(receipt.completionDetail === undefined ? {} : { completionDetail: receipt.completionDetail }),
  };
}

/** Last visible child operations; the dispatch receipt joins all of them. */
export function childLeaves(steps: readonly { readonly id: string; readonly after?: readonly string[] }[]): string[] {
  const visible = steps.filter(step => !/(?:^|--)complete-[1-9][0-9]*$/.test(step.id));
  const parents = new Set(visible.flatMap(step => step.after ?? []));
  return visible.map(step => step.id).filter(id => !parents.has(id));
}

/** A child may use only provider/MCP capabilities its parent already declared. */
function assertChildCapabilities(
  parent: RequirementsFlowDefinition & { readonly name: string },
  child: RequirementsFlowDefinition & { readonly name: string },
): void {
  const parentTools = parent.header?.tools ?? {};
  const childTools = child.header?.tools ?? {};
  for (const [tool, declared] of Object.entries(childTools)) {
    if (tool === 'mcp') {
      const allowed = new Set(Array.isArray(parentTools.mcp) ? parentTools.mcp as readonly unknown[] : []);
      const requested = Array.isArray(declared) ? declared : [];
      if (requested.some(server => !allowed.has(server))) {
        throw new AuthoredFlowExecutionError(
          'dispatch_invalid',
          `child flow "${child.name}" widens tools.mcp beyond parent "${parent.name}"`,
        );
      }
    }
  }
  const parentHelpers = helperAuthority(parent);
  for (const requirement of flowRequirements(child).integrations) {
    if ((requirement.from === 'tools' || requirement.from === 'helper')
      && !parentHelpers.has(requirement.provider)) {
      throw new AuthoredFlowExecutionError(
        'dispatch_invalid',
        `child flow "${child.name}" requires ${requirement.detail}, which parent "${parent.name}" did not grant`,
      );
    }
  }
}

/** Helper providers this flow can delegate, from explicit or statically visible use. */
export function helperAuthority(
  definition: RequirementsFlowDefinition,
): ReadonlySet<string> {
  return new Set(flowRequirements(definition).integrations
    .filter(requirement => requirement.from === 'tools' || requirement.from === 'helper')
    .map(requirement => requirement.provider));
}
