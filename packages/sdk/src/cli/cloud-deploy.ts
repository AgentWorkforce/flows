import { CloudFlowError } from '../cloud-http.js';
import {
  deployToCloud, listCloudDeployments, parseAgentHarnesses, parseRepository, parseTriggerSource, undeployFromCloud,
  type FlowTriggerSource,
} from '../cloud-deploy.js';
import type { CliIo } from '../cli.js';

export interface CloudDeployArgs {
  command: 'cloud-deploy';
  value: string;
  repo: string;
  on: string[];
  approver: string | undefined;
  name: string | undefined;
  agents: string | undefined;
  draft: boolean;
  json: boolean;
}

/**
 * `flows deploy <flow.ts> --repo <owner/name> --on <provider>[:k=v,…] [--on …]
 *   --approver <handle> [--name <n>] [--json]`
 *
 * Parsed here rather than in `parseDeployArgs` because the two `deploy` forms
 * share nothing but the word: the digest form copies a sealed bundle into a
 * file bucket, this one creates a hosted listener. The positional decides.
 */
export function parseCloudDeployArgs(args: readonly string[]): CloudDeployArgs | undefined {
  let value: string | undefined;
  let repo: string | undefined;
  let approver: string | undefined;
  let name: string | undefined;
  let agents: string | undefined;
  let draft = false;
  let json = false;
  const on: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      if (json) return undefined;
      json = true;
      continue;
    }
    if (arg === '--draft') {
      if (draft) return undefined;
      draft = true;
      continue;
    }
    if (arg === '--agents') {
      const next = args[i + 1];
      if (agents !== undefined || next === undefined || next.startsWith('-')) return undefined;
      agents = next;
      i += 1;
      continue;
    }
    if (arg === '--repo' || arg === '--approver' || arg === '--name' || arg === '--on') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) return undefined;
      i += 1;
      if (arg === '--on') { on.push(next); continue; }
      if (arg === '--repo') { if (repo !== undefined) return undefined; repo = next; continue; }
      if (arg === '--approver') { if (approver !== undefined) return undefined; approver = next; continue; }
      if (name !== undefined) return undefined;
      name = next;
      continue;
    }
    if (arg.startsWith('-') || value !== undefined) return undefined;
    value = arg;
  }
  if (value === undefined || repo === undefined || on.length === 0) return undefined;
  return { command: 'cloud-deploy', value, repo, on, approver, name, agents, draft, json };
}

function describeSource(source: FlowTriggerSource): string {
  const settings = Object.entries(source.settings).map(([k, v]) => `${k}=${v}`).join(' ');
  return settings ? `${source.provider} ${settings}` : source.provider;
}

export async function runCloudDeployCli(args: CloudDeployArgs, io: CliIo): Promise<0 | 1 | 2> {
  try {
    if (args.approver === undefined) {
      throw new CloudFlowError('invalid_input',
        '--approver <handle> is required: every launched run receives it as input.approver for f.human.');
    }
    const deployment = await deployToCloud({
      path: args.value,
      repository: parseRepository(args.repo),
      sources: args.on.map(parseTriggerSource),
      approver: args.approver,
      draft: args.draft,
      ...(args.name === undefined ? {} : { name: args.name }),
      ...(args.agents === undefined ? {} : { agents: parseAgentHarnesses(args.agents) }),
    });
    if (args.json) {
      io.stdout(JSON.stringify({ ok: true, ...deployment }));
      return 0;
    }
    io.stdout(`${deployment.status === 'draft' ? 'SAVED' : 'DEPLOYED'} ${deployment.agentId} ${deployment.status}`);
    io.stdout(`  flow: ${deployment.name} (${args.value}, sha256 ${deployment.sourceSha256.slice(0, 12)})`);
    io.stdout(`  repository: ${deployment.repository.owner}/${deployment.repository.name}`);
    for (const source of deployment.sources) io.stdout(`  on: ${describeSource(source)}`);
    io.stdout(deployment.status === 'draft'
      ? 'Saved without activating; activate it from the Cloud dashboard, or redeploy without --draft.'
      : 'Each matching ticket launches a run of this source in a fresh branch; list with: flows deployments');
    return 0;
  } catch (error) {
    return reportCloudFailure(error, args.json, io);
  }
}

export async function runCloudDeploymentsCli({ json }: { json: boolean }, io: CliIo): Promise<0 | 1 | 2> {
  try {
    const deployments = await listCloudDeployments();
    if (json) {
      io.stdout(JSON.stringify({ ok: true, deployments }));
      return 0;
    }
    if (deployments.length === 0) {
      io.stdout('No flow deployments in this workspace.');
      return 0;
    }
    for (const d of deployments) {
      const repo = d.repository ? ` ${d.repository.owner}/${d.repository.name}` : '';
      io.stdout(`${d.agentId} ${d.status} ${JSON.stringify(d.name)}${repo}`);
      for (const source of d.sources) io.stdout(`  on: ${describeSource(source)}`);
    }
    return 0;
  } catch (error) {
    return reportCloudFailure(error, json, io);
  }
}

export async function runCloudUndeployCli({ agentId, json }: { agentId: string; json: boolean }, io: CliIo): Promise<0 | 1 | 2> {
  try {
    await undeployFromCloud(agentId);
    io.stdout(json ? JSON.stringify({ ok: true, agentId, status: 'deleted' }) : `UNDEPLOYED ${agentId}`);
    return 0;
  } catch (error) {
    return reportCloudFailure(error, json, io);
  }
}

function reportCloudFailure(error: unknown, json: boolean, io: CliIo): 1 | 2 {
  const code = error instanceof CloudFlowError ? error.code : 'cloud_deploy_failed';
  let message = error instanceof Error ? error.message : 'Cloud deploy failed.';
  // The deploy routes take a browser session or a `cli:auth` token. A
  // deployment (CI) token gets 403 `session_required`; say what fixes it.
  if (error instanceof CloudFlowError && error.status === 403) {
    message += ' Deploying needs an interactive `cli:auth` credential: run `agent-relay cloud login` '
      + '(a deployment token can run flows but not deploy them).';
  }
  if (json) io.stdout(JSON.stringify({ ok: false, code, message }));
  else io.stderr(`${code}: ${message}`);
  return error instanceof CloudFlowError
    && (['configuration', 'unsupported_source', 'invalid_input'].includes(error.code) || error.status === 403 || error.status === 401)
    ? 2 : 1;
}
