import { helperProviders } from '@relayflows/surface/runtime';
import type { TriggerSource } from '@relayflows/surface';
import { providerDeclaration } from './provider-trigger-contract.js';
import type { FlowSpec } from './spec.js';

/**
 * What a flow needs from the workspace it deploys into, read from inert
 * declarations only: the header, the trigger sources, and the text of the
 * body. Nothing here executes a body or opens a socket, so the same answer is
 * available to `flows check`, to the hosted verbs before they submit, and to
 * Cloud's deploy wizard from the source alone.
 *
 * Helper use is recognised exactly as `preflightHelpers` recognises it — a
 * `tools.<namespace>: true` flag or a `f.<namespace>` reference in the body —
 * so a flow that preflight would refuse for a missing mount is a flow whose
 * integration this module names. Coding-agent harnesses come from the `cli:`
 * each `f.agent`/`f.llm` call declares, else the project default, else Cloud's
 * default (`claude`): the same precedence `resolveCli` applies at run time.
 */

export const FLOW_HARNESSES = ['claude', 'codex', 'gemini'] as const;
export type FlowHarness = (typeof FLOW_HARNESSES)[number];

export interface FlowIntegrationRequirement {
  /** Cloud integration provider id (`slack`, `github`, `linear`, …). */
  provider: string;
  /** `tools`: a header declaration; `source`: a trigger or deploy target; `helper`: body use without a flag. */
  from: 'tools' | 'source' | 'helper';
  /** The declaration that requires it, as a reader would name it: `tools.slack`, `--on github`, `f.slack`. */
  detail: string;
}

export interface FlowHarnessRequirement {
  harness: FlowHarness;
  /** `agent "review"`, `llm step`, `step "draft"`, or `default`. */
  detail: string;
}

export interface FlowRequirements {
  integrations: FlowIntegrationRequirement[];
  harnesses: FlowHarness[];
  /** One entry per harness, naming the first declaration that needs it. */
  harnessUses: FlowHarnessRequirement[];
  /** MCP servers `tools.mcp` names; the workspace must declare each in `flows.json`. */
  mcp: string[];
}

export interface FlowRequirementsContext {
  /** Trigger sources the deployment listens on (`--on`, or the wizard's chosen sources). */
  sources?: readonly { provider: string }[];
  /** Set when the deployment targets a repository: every launched run needs GitHub. */
  repository?: boolean | { owner: string; name: string };
  /** The nearest `flows.json` `cli`, when one applies. */
  projectCli?: string;
}

/** The inert subset of an authored definition this module reads. */
export interface RequirementsFlowDefinition {
  readonly header?: { readonly tools?: Readonly<Record<string, unknown>> };
  readonly body?: Function;
  readonly handlers?: readonly { readonly trigger: TriggerSource; readonly body?: Function }[];
}

export function flowRequirements(
  flow: RequirementsFlowDefinition | FlowSpec,
  context: FlowRequirementsContext = {},
): FlowRequirements {
  const integrations = new Map<string, FlowIntegrationRequirement>();
  const harnessUses = new Map<FlowHarness, FlowHarnessRequirement>();
  const mcp = new Set<string>();
  const declare = (requirement: FlowIntegrationRequirement): void => {
    if (!integrations.has(requirement.provider)) integrations.set(requirement.provider, requirement);
  };
  const need = (harness: FlowHarness | undefined, detail: string): void => {
    if (harness !== undefined && !harnessUses.has(harness)) harnessUses.set(harness, { harness, detail });
  };
  const fallback = harnessFromCli(context.projectCli) ?? 'claude';

  if (isCompiledSpec(flow)) {
    for (const step of flow.steps) {
      if (step.type !== 'llm' && step.type !== 'agent') continue;
      const named = step.type === 'agent' && step.agent !== undefined ? flow.agents?.[step.agent]?.cli : undefined;
      const cli = step.cli ?? named ?? flow.cli;
      need(cli === undefined ? fallback : harnessFromCli(cli), `step "${step.id}"`);
    }
  } else {
    const tools = flow.header?.tools ?? {};
    for (const { provider, namespace } of helperProviders) {
      if (tools[namespace] === true) declare({ provider, from: 'tools', detail: `tools.${namespace}` });
    }
    for (const entry of stringList(tools['relayfile'])) {
      const provider = entry.split('/')[0]?.trim();
      if (provider) declare({ provider, from: 'tools', detail: 'tools.relayfile' });
    }
    for (const server of stringList(tools['mcp'])) mcp.add(server);
    for (const handler of flow.handlers ?? []) {
      const declaration = providerDeclaration(handler.trigger);
      if (declaration !== undefined) {
        declare({ provider: declaration.provider, from: 'source', detail: `on ${declaration.provider} ${declaration.type}` });
      }
    }
    const bodies = [flow.body, ...(flow.handlers ?? []).map(handler => handler.body)]
      .flatMap(body => typeof body === 'function' ? [Function.prototype.toString.call(body)] : []);
    for (const text of bodies) {
      const root = contextParameter(text);
      if (root === undefined) continue;
      for (const { provider, namespace } of helperProviders) {
        if (helperReference(root, namespace).test(text)) declare({ provider, from: 'helper', detail: `f.${namespace}` });
      }
      for (const use of workerCalls(root, text)) need(use.cli === undefined ? fallback : harnessFromCli(use.cli), use.detail);
    }
  }

  for (const source of context.sources ?? []) {
    declare({ provider: source.provider, from: 'source', detail: `--on ${source.provider}` });
  }
  if (context.repository) declare({ provider: 'github', from: 'source', detail: 'deploy target' });

  const uses = [...harnessUses.values()];
  return {
    integrations: [...integrations.values()],
    harnesses: uses.map(use => use.harness),
    harnessUses: uses,
    mcp: [...mcp],
  };
}

/** `slack (tools.slack), github (deploy target), claude (agent "review")` — the `REQUIRES` line's body. */
export function describeFlowRequirements(requirements: FlowRequirements): string {
  return [
    ...requirements.integrations.map(integration => `${integration.provider} (${integration.detail})`),
    ...requirements.harnessUses.map(use => `${use.harness} (${use.detail})`),
    ...requirements.mcp.map(server => `mcp ${server} (tools.mcp)`),
  ].join(', ');
}

/** `claude`, `/opt/bin/codex`, `gemini.exe` → the Cloud harness; anything else is not one. */
export function harnessFromCli(cli: string | undefined): FlowHarness | undefined {
  if (cli === undefined) return undefined;
  const base = cli.trim().split(/[\\/]/u).pop()?.replace(/\.(?:exe|cmd|bat)$/iu, '').toLowerCase();
  return (FLOW_HARNESSES as readonly string[]).includes(base ?? '') ? base as FlowHarness : undefined;
}

function isCompiledSpec(flow: RequirementsFlowDefinition | FlowSpec): flow is FlowSpec {
  return Array.isArray((flow as FlowSpec).steps) && typeof (flow as FlowSpec).version === 'string';
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** The body's first parameter (`f` in `async (f, input) => …`), escaped for a pattern. */
function contextParameter(body: string): string | undefined {
  const parameter = body.match(/^(?:async\s+)?(?:function(?:\s+[\w$]+)?\s*)?(?:\(\s*([\w$]+)|([\w$]+)\s*=>)/u);
  return (parameter?.[1] ?? parameter?.[2])?.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Same recognition as `preflightHelpers`: `f.slack`, `f .slack`, `f["slack"]`. */
function helperReference(root: string, namespace: string): RegExp {
  return new RegExp(`(?:^|[^\\w$.])${root}\\s*(?:\\.\\s*${namespace}\\b|\\[\\s*['"]${namespace}['"]\\s*\\])`, 'u');
}

interface WorkerCall { detail: string; cli?: string }

/**
 * Each `f.agent(name, { cli })` / `f.llm(prompt, { cli })` call and the CLI it
 * declares. The options object is read only up to the next worker call, so a
 * `cli:` belongs to the call it follows; a call without one takes the default.
 */
function workerCalls(root: string, body: string): WorkerCall[] {
  const call = new RegExp(`(?:^|[^\\w$.])${root}\\s*\\.\\s*(agent|llm)\\s*\\(\\s*(?:(['"\`])([^'"\`]*)\\2)?`, 'gu');
  const starts = [...body.matchAll(call)];
  return starts.map((match, index) => {
    const slice = body.slice(match.index! + match[0].length, starts[index + 1]?.index ?? body.length);
    const cli = slice.match(/(?:^|[^\w$])cli\s*:\s*(['"`])([^'"`]*)\1/u)?.[2];
    const detail = match[1] === 'agent'
      ? (match[3] ? `agent ${JSON.stringify(match[3])}` : 'agent step')
      : 'llm step';
    return { detail, ...(cli === undefined ? {} : { cli }) };
  });
}
