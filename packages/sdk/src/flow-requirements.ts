import { humanRecipientProvider } from './human-to.js';
import { helperProviders } from '@relayflows/surface/runtime';
import type { TriggerSource } from '@relayflows/surface';
import { providerDeclaration } from './provider-trigger-contract.js';
import type { FlowSpec } from './spec.js';
import { helperCall } from './yaml-helpers.js';

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
  /** `tools`: a header declaration; `source`: a trigger or deploy target; `helper`: body use without a flag, or a YAML helper step. */
  from: 'tools' | 'source' | 'helper' | 'human';
  /** The declaration that requires it, as a reader would name it: `tools.slack`, `--on github`, `f.slack`, `f.human to`. */
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
  readonly handlers?: readonly { readonly trigger: TriggerSource }[];
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
      // Preflight owns shape refusals; a malformed step is simply not a worker step here.
      if (typeof step !== 'object' || step === null || (step.type !== 'llm' && step.type !== 'agent')) continue;
      // A YAML helper step (`slack: { post: … }`) compiles to an agent step
      // carrying a helper envelope: it needs the provider's mount, not a harness.
      const helper = step.type === 'agent' ? compiledHelper(step) : undefined;
      if (helper !== undefined) {
        declare({ provider: helper, from: 'helper', detail: `step "${step.id}"` });
        continue;
      }
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
    // Only the default body is scanned for helper and worker calls: hosted
    // deployments and schedules dispatch the default body with the trigger's
    // payload as input, and handler bodies are not dispatched yet (flows #301).
    // A handler's *trigger* is still a requirement — it is what wakes the flow.
    const text = typeof flow.body === 'function' ? Function.prototype.toString.call(flow.body) : '';
    const root = contextParameter(text);
    if (root !== undefined) {
      for (const { provider, namespace } of helperProviders) {
        if (helperReference(root, namespace).test(text)) declare({ provider, from: 'helper', detail: `f.${namespace}` });
      }
      for (const use of workerCalls(root, text)) need(use.cli === undefined ? fallback : harnessFromCli(use.cli), use.detail);
      // `f.human(q, { to: "slack:#eng" })` is delivered by Cloud through that
      // provider, so the deploy must have it connected. Only a literal `to`
      // can be read here; a computed one (`input.approver`) is resolved by
      // Cloud at park time against the run's own trigger channel.
      for (const to of humanRecipients(root, text)) {
        const provider = humanRecipientProvider(to);
        if (provider !== undefined) declare({ provider, from: 'human', detail: 'f.human to' });
      }
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

/** The provider of a compiled YAML helper step, or undefined for an ordinary agent step or a malformed envelope. */
function compiledHelper(step: Parameters<typeof helperCall>[0]): string | undefined {
  try {
    return helperCall(step)?.provider;
  } catch {
    return undefined;
  }
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

/**
 * The literal `to` of each `f.human(question, { to: "…" })` call in the body.
 *
 * Bounded to the call's OWN argument list — the text between its `(` and the
 * matching `)`, string- and nesting-aware — and within that to the top level
 * of its options object, so a `to:` in a later call, in a nested object, in
 * the question string, or in an unrelated `{ to }` of the surrounding code is
 * never read as this call's recipient. Only a plain string literal counts; a
 * template with interpolation or an identifier is a computed `to`, resolved
 * by Cloud at park time.
 */
function humanRecipients(root: string, body: string): string[] {
  const call = new RegExp(`(?:^|[^\\w$.])${root}\\s*\\.\\s*human\\s*\\(`, 'gu');
  const found: string[] = [];
  for (const match of body.matchAll(call)) {
    const open = match.index! + match[0].length - 1;
    const close = matchingClose(body, open);
    if (close === -1) continue;
    const args = body.slice(open + 1, close);
    const options = secondArgumentObject(args);
    if (options === undefined) continue;
    const to = topLevelStringProperty(options, 'to');
    if (to !== undefined) found.push(to);
  }
  return found;
}

/** Index of the `)`/`}`/`]` closing the bracket at `open`, skipping strings, templates and comments; -1 if unbalanced. */
function matchingClose(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [pairs[text[open]!]!];
  let i = open + 1;
  while (i < text.length && stack.length > 0) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === '/' && next === '/') { i = text.indexOf('\n', i); if (i === -1) return -1; continue; }
    if (ch === '/' && next === '*') { const end = text.indexOf('*/', i + 2); if (end === -1) return -1; i = end + 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { i = stringEnd(text, i); if (i === -1) return -1; i += 1; continue; }
    if (ch in pairs) stack.push(pairs[ch]!);
    else if (ch === ')' || ch === '}' || ch === ']') { if (stack.pop() !== ch) return -1; }
    i += 1;
  }
  return stack.length === 0 ? i - 1 : -1;
}

/** Index of the quote closing the string opening at `start` (template `${…}` skipped); -1 if unterminated. */
function stringEnd(text: string, start: number): number {
  const quote = text[start]!;
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\') { i += 2; continue; }
    if (ch === quote) return i;
    if (quote === '`' && ch === '$' && text[i + 1] === '{') {
      const end = matchingClose(text, i + 1);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return -1;
}

/** The `{ … }` that is the call's second top-level argument, or undefined. */
function secondArgumentObject(args: string): string | undefined {
  let depth = 0;
  let i = 0;
  let commas = 0;
  while (i < args.length) {
    const ch = args[i]!;
    if (ch === '"' || ch === "'" || ch === '`') { i = stringEnd(args, i); if (i === -1) return undefined; i += 1; continue; }
    if (ch === '(' || ch === '{' || ch === '[') {
      if (depth === 0 && commas === 1 && ch === '{') {
        const close = matchingClose(args, i);
        return close === -1 ? undefined : args.slice(i, close + 1);
      }
      depth += 1;
    } else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) commas += 1;
    i += 1;
  }
  return undefined;
}

/** The plain string literal value of `name:` at the top level of an object literal, else undefined. */
function topLevelStringProperty(object: string, name: string): string | undefined {
  let depth = 0;
  let i = 1; // past the opening brace
  const end = object.length - 1;
  while (i < end) {
    const ch = object[i]!;
    if (ch === '"' || ch === "'" || ch === '`') { i = stringEnd(object, i); if (i === -1) return undefined; i += 1; continue; }
    if (ch === '(' || ch === '{' || ch === '[') { depth += 1; i += 1; continue; }
    if (ch === ')' || ch === '}' || ch === ']') { depth -= 1; i += 1; continue; }
    if (depth === 0 && (i === 1 || /[\s,{]/u.test(object[i - 1]!))) {
      const key = new RegExp(`^(?:${name}|'${name}'|"${name}")\\s*:\\s*`, 'u').exec(object.slice(i));
      if (key !== null) {
        const valueStart = i + key[0].length;
        const quote = object[valueStart];
        if (quote !== '"' && quote !== "'" && quote !== '`') return undefined;
        const valueEnd = stringEnd(object, valueStart);
        if (valueEnd === -1) return undefined;
        const raw = object.slice(valueStart + 1, valueEnd);
        // An interpolated template is computed; a plain one is a literal.
        return quote === '`' && /\$\{/u.test(raw) ? undefined : raw.replace(/\\(.)/gu, '$1');
      }
    }
    i += 1;
  }
  return undefined;
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
