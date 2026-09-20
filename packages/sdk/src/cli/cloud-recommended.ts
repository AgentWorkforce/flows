import { CloudFlowError } from '../cloud-http.js';
import { parseAgentHarnesses, parseRepository } from '../cloud-deploy.js';
import {
  activateRecommendedFlow, getRecommendedFlow, listRecommendedFlows,
  type RecommendedFlowActivation, type RecommendedFlowDetail,
} from '../cloud-recommended.js';
import type { CliIo } from '../cli.js';

export type CloudRecommendedArgs =
  | { command: 'recommended-list'; json: boolean }
  | { command: 'recommended-show'; flowId: string; json: boolean }
  | { command: 'recommended-activate'; flowId: string; label: string; repositories: string[]; approver: string; agents: string | undefined; json: boolean };

export function parseCloudRecommendedArgs(args: readonly string[]): CloudRecommendedArgs | undefined {
  const subcommand = args[0];
  if (subcommand === 'list') return args.length === 1 ? { command: 'recommended-list', json: false }
    : args.length === 2 && args[1] === '--json' ? { command: 'recommended-list', json: true } : undefined;
  if (subcommand === 'show') {
    const rest = args.slice(1).filter(arg => arg !== '--json');
    const json = args.length - 1 - rest.length;
    return json <= 1 && rest.length === 1 && !rest[0]!.startsWith('-') ? { command: 'recommended-show', flowId: rest[0]!, json: json === 1 } : undefined;
  }
  if (subcommand !== 'activate') return undefined;
  let flowId: string | undefined;
  let label: string | undefined;
  let approver: string | undefined;
  let agents: string | undefined;
  let json = false;
  const repositories: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--json') { if (json) return undefined; json = true; continue; }
    if (arg === '--label' || arg === '--approver' || arg === '--agents' || arg === '--repository') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) return undefined;
      index += 1;
      if (arg === '--repository') { repositories.push(value); continue; }
      if (arg === '--label') { if (label !== undefined) return undefined; label = value; continue; }
      if (arg === '--approver') { if (approver !== undefined) return undefined; approver = value; continue; }
      if (agents !== undefined) return undefined;
      agents = value;
      continue;
    }
    if (arg.startsWith('-') || flowId !== undefined) return undefined;
    flowId = arg;
  }
  return flowId === undefined || label === undefined || approver === undefined || repositories.length === 0 ? undefined
    : { command: 'recommended-activate', flowId, label, repositories, approver, agents, json };
}

export async function runCloudRecommendedCli(args: CloudRecommendedArgs, io: CliIo): Promise<0 | 1 | 2> {
  try {
    if (args.command === 'recommended-list') {
      const catalog = await listRecommendedFlows();
      if (args.json) io.stdout(JSON.stringify({ ok: true, ...catalog }));
      else if (catalog.flows.length === 0) io.stdout('No recommended flows are available.');
      else for (const flow of catalog.flows) io.stdout(`${flow.id} v${flow.version} ${JSON.stringify(flow.name)}\n  ${flow.summary}`);
      return 0;
    }
    if (args.command === 'recommended-show') {
      const flow = await getRecommendedFlow(args.flowId);
      if (args.json) io.stdout(JSON.stringify({ ok: true, flow }));
      else renderFlow(flow, io);
      return 0;
    }
    const agents = args.agents === undefined ? undefined : parseAgentHarnesses(args.agents);
    const activation = await activateRecommendedFlow({
      flowId: args.flowId, label: args.label, approver: args.approver,
      repositories: args.repositories.map(parseRepository), ...(agents === undefined ? {} : { agents }),
    });
    if (args.json) io.stdout(JSON.stringify({ ok: true, ...activation }));
    else renderActivation(activation, io);
    return 0;
  } catch (error) {
    const code = error instanceof CloudFlowError ? error.code : 'recommended_flow_failed';
    const message = error instanceof Error ? error.message : 'Recommended-flow request failed.';
    if (args.json) io.stdout(JSON.stringify({ ok: false, code, message }));
    else io.stderr(`${code}: ${message}`);
    return error instanceof CloudFlowError && (['configuration', 'invalid_input', 'invalid_response'].includes(error.code)
      || error.status === 401 || error.status === 403) ? 2 : 1;
  }
}

function renderFlow(flow: RecommendedFlowDetail, io: CliIo): void {
  io.stdout(`${flow.id} v${flow.version} ${JSON.stringify(flow.name)}`);
  io.stdout(flow.description);
  io.stdout(`  workflow: ${flow.workflow}`);
  io.stdout(`  default label: ${flow.defaultLabel}`);
  io.stdout(`  repository hosts: ${flow.supportedRepositoryHosts.join(', ')}`);
  io.stdout(`  trigger: ${flow.defaultTrigger.provider}`);
  io.stdout(`  required inputs: ${flow.inputs.required.join(', ') || 'none'}`);
  const agents = flow.inputs.defaults['agents'];
  if (Array.isArray(agents) && agents.every(agent => typeof agent === 'string')) io.stdout(`  default agents: ${agents.join(', ')}`);
  if (flow.sourceParameters !== undefined) io.stdout(`  source parameters: ${Object.keys(flow.sourceParameters).join(', ')}`);
}

function renderActivation(activation: RecommendedFlowActivation, io: CliIo): void {
  io.stdout(`ACTIVATED ${activation.activationId} ${activation.status}`);
  io.stdout(`  flow: ${activation.flowId}`);
  io.stdout(`  label: ${activation.label}`);
  for (const repository of activation.repositories) io.stdout(`  repository: ${repository.owner}/${repository.name}`);
  for (const listener of activation.listeners) io.stdout(`  listener: ${listener.agentId} ${listener.status} ${listener.repository.owner}/${listener.repository.name}`);
}
