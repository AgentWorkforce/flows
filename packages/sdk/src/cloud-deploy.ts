import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadAuthoredFlow } from './authored-flow-loader.js';
import {
  CloudFlowError, cloudFetch, cloudRequest, isCloudRecord, type CloudConnectionOptions,
} from './cloud-http.js';

/**
 * Hosted listener deployment: the CLI form of the agentrelay.com onboarding's
 * deploy wizard. `POST /api/v1/flows/deploy` stores one self-contained
 * authored source and creates a proactive listener whose watch rules match
 * the chosen ticket sources on the workspace's relayfile projections. There
 * is no webhook to register: the GitHub App installation (or Slack/Linear/
 * Jira/Shortcut connection) is the ingress, and each matching ticket launches
 * a run of the stored source with `{ approver, issue, event }` as its input,
 * inside a fresh branch of the deployment's repository.
 */

export const FLOW_TRIGGER_PROVIDERS = ['github', 'linear', 'jira', 'shortcut', 'slack'] as const;
export type FlowTriggerProvider = (typeof FLOW_TRIGGER_PROVIDERS)[number];

/** Settings Cloud's launcher prefilter reads per provider (`flow-trigger-sources.ts`). */
const PROVIDER_SETTINGS: Record<FlowTriggerProvider, readonly string[]> = {
  // `events`: `issues` (default) or `pull_request` — which GitHub records
  // wake the listener (AgentWorkforce/cloud#3772).
  github: ['repository', 'labels', 'contains', 'events'],
  slack: ['channel', 'contains'],
  linear: ['team', 'contains'],
  jira: ['project', 'contains'],
  shortcut: ['workspace', 'contains'],
};
const MAX_SOURCE_BYTES = 256_000;
const MAX_SETTING_LENGTH = 500;
const REPO_OWNER = /^[A-Za-z0-9-]{1,39}$/u;
const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/u;

export interface FlowTriggerSource {
  provider: FlowTriggerProvider;
  settings: Record<string, string>;
}

export interface DeployToCloudInput {
  path: string;
  repository: { owner: string; name: string };
  sources: FlowTriggerSource[];
  /** The `f.human` approver handle every launched run receives as `input.approver`. */
  approver: string;
  /** Defaults to the flow's declared name. */
  name?: string;
  /** Coding-agent harnesses the flow uses; Cloud checks their credentials are connected. Default `["claude"]`. */
  agents?: FlowAgentHarness[];
  /** Save without activating: no connection checks, no listener until activated. */
  draft?: boolean;
}

export const FLOW_AGENT_HARNESSES = ['claude', 'codex'] as const;
export type FlowAgentHarness = (typeof FLOW_AGENT_HARNESSES)[number];

export function parseAgentHarnesses(value: string): FlowAgentHarness[] {
  const agents = value.split(',').map(a => a.trim()).filter(Boolean);
  if (agents.length === 0 || agents.length > 2 || new Set(agents).size !== agents.length
    || !agents.every(a => (FLOW_AGENT_HARNESSES as readonly string[]).includes(a))) {
    throw new CloudFlowError('invalid_input', `--agents takes one or two of ${FLOW_AGENT_HARNESSES.join(', ')}, got "${value}".`);
  }
  return agents as FlowAgentHarness[];
}

export interface CloudDeployment {
  agentId: string;
  name: string;
  status: string;
  repository: { owner: string; name: string };
  sources: FlowTriggerSource[];
  sourceSha256: string;
}

export function parseRepository(value: string): { owner: string; name: string } {
  const [owner, name, extra] = value.replace(/^https?:\/\/github\.com\//iu, '').replace(/\.git$/iu, '').split('/');
  if (!owner || !name || extra !== undefined || !REPO_OWNER.test(owner) || !REPO_NAME.test(name)) {
    throw new CloudFlowError('invalid_input', `Expected --repo <owner>/<name>, got "${value}".`);
  }
  return { owner, name };
}

/** `github`, `github:labels=agent,contains=urgent`, `slack:channel=#eng`. */
export function parseTriggerSource(value: string): FlowTriggerSource {
  const colon = value.indexOf(':');
  const provider = (colon === -1 ? value : value.slice(0, colon)).trim();
  if (!(FLOW_TRIGGER_PROVIDERS as readonly string[]).includes(provider)) {
    throw new CloudFlowError('invalid_input',
      `Unknown trigger provider "${provider}"; expected one of ${FLOW_TRIGGER_PROVIDERS.join(', ')}.`);
  }
  const allowed = PROVIDER_SETTINGS[provider as FlowTriggerProvider];
  const settings: Record<string, string> = {};
  if (colon !== -1) {
    for (const pair of value.slice(colon + 1).split(',')) {
      const eq = pair.indexOf('=');
      const key = (eq === -1 ? pair : pair.slice(0, eq)).trim();
      const setting = eq === -1 ? '' : pair.slice(eq + 1).trim();
      if (!allowed.includes(key)) {
        throw new CloudFlowError('invalid_input',
          `"${key}" is not a ${provider} trigger setting; ${provider} accepts ${allowed.join(', ')}.`);
      }
      if (!setting || setting.length > MAX_SETTING_LENGTH || key in settings) {
        throw new CloudFlowError('invalid_input', `Trigger setting "${key}" must be given once with a non-empty value.`);
      }
      if (key === 'events') {
        // Cloud's enum is lowercase; send it that way whatever the shell typed.
        const events = setting.toLowerCase();
        if (!['issues', 'pull_request'].includes(events)) {
          throw new CloudFlowError('invalid_input', `github events must be "issues" or "pull_request", got "${setting}".`);
        }
        settings[key] = events;
        continue;
      }
      settings[key] = setting;
    }
  }
  return { provider: provider as FlowTriggerProvider, settings };
}

export async function deployToCloud(
  input: DeployToCloudInput, options: CloudConnectionOptions = {},
): Promise<CloudDeployment> {
  if (!/\.flow\.ts$/iu.test(input.path)) {
    throw new CloudFlowError('unsupported_source', 'flows deploy takes one authored .flow.ts source.');
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(input.path);
  } catch (error) {
    throw new CloudFlowError('invalid_input',
      `Cannot read ${input.path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}.`);
  }
  const source = bytes.toString('utf8');
  if (!bytes.length || Buffer.from(source, 'utf8').compare(bytes) !== 0) {
    throw new CloudFlowError('invalid_input', 'Authored source must be nonempty, lossless UTF-8.');
  }
  if (bytes.length > MAX_SOURCE_BYTES) {
    throw new CloudFlowError('invalid_input', `Authored source exceeds Cloud's ${MAX_SOURCE_BYTES}-byte deploy limit.`);
  }
  let loaded: Awaited<ReturnType<typeof loadAuthoredFlow>>;
  let definition: ReturnType<typeof loaded.getDefinition>;
  try {
    loaded = await loadAuthoredFlow(input.path);
    definition = loaded.getDefinition(loaded.handle);
  } catch (error) {
    if (error instanceof CloudFlowError) throw error;
    // A source that does not load is an authoring problem, refused before HTTP.
    throw new CloudFlowError('unsupported_source',
      `${input.path} is not a loadable authored flow: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (loaded.graph.length !== 1) {
    throw new CloudFlowError('unsupported_source',
      'Cloud deploys one self-contained .flow.ts source without use dependencies.');
  }
  if (input.sources.length === 0 || input.sources.length > 10) {
    throw new CloudFlowError('invalid_input', 'Give between one and ten --on trigger sources.');
  }
  if (new Set(input.sources.map(s => s.provider)).size !== input.sources.length) {
    throw new CloudFlowError('invalid_input', 'Each trigger provider can be given once.');
  }
  const approver = input.approver.trim();
  if (!approver) throw new CloudFlowError('invalid_input', '--approver must name who approves f.human questions.');
  const name = (input.name ?? definition.name).trim();
  if (!name || name.length > 100) throw new CloudFlowError('invalid_input', 'Deployment name must be 1-100 characters.');
  // A GitHub source scoped to nothing would wake on every repository the
  // installation covers; default it to the deployment's own repository.
  const sources = input.sources.map(s => s.provider === 'github' && s.settings['repository'] === undefined
    ? { ...s, settings: { ...s.settings, repository: `${input.repository.owner}/${input.repository.name}` } }
    : s);
  options.signal?.throwIfAborted();

  const whoami = await cloudRequest('/api/v1/auth/whoami', options);
  const workspace = isCloudRecord(whoami) && isCloudRecord(whoami.currentWorkspace) ? whoami.currentWorkspace : undefined;
  if (workspace === undefined || typeof workspace.id !== 'string' || !workspace.id) {
    throw new CloudFlowError('invalid_response', 'Cloud did not report a current workspace for this credential.');
  }
  const agents = input.agents ?? ['claude'];
  const result = await cloudFetch('/api/v1/flows/deploy', options, { method: 'POST', detail: true, body: JSON.stringify({
    workspaceId: workspace.id,
    mode: input.draft ? 'draft' : 'activate',
    name,
    // The onboarding's workflow-shape label; the CLI deploys authored source as-is.
    workflow: 'flows-cli',
    source,
    handoffId: `flows-cli-${randomBytes(8).toString('hex')}`,
    inputs: { approver, agents },
    repository: input.repository,
    sources,
  }) });
  if (!isCloudRecord(result) || typeof result.agentId !== 'string' || typeof result.status !== 'string') {
    throw new CloudFlowError('invalid_response', 'Cloud did not return a deployment.');
  }
  return {
    agentId: result.agentId, name, status: result.status,
    repository: input.repository, sources,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export interface CloudDeploymentSummary {
  agentId: string;
  name: string;
  status: string;
  repository?: { owner: string; name: string };
  sources: FlowTriggerSource[];
  createdAt?: string;
  updatedAt?: string;
}

export async function listCloudDeployments(options: CloudConnectionOptions = {}): Promise<CloudDeploymentSummary[]> {
  const payload = await cloudRequest('/api/v1/agents/flow-deployments', options);
  if (!isCloudRecord(payload) || !Array.isArray(payload.deployments)) {
    throw new CloudFlowError('invalid_response', 'Cloud did not return a deployments list.');
  }
  return payload.deployments.map((row): CloudDeploymentSummary => {
    if (!isCloudRecord(row) || typeof row.agentId !== 'string' || typeof row.name !== 'string') {
      throw new CloudFlowError('invalid_response', 'Cloud returned a malformed deployment row.');
    }
    const repository = isCloudRecord(row.repository) && typeof row.repository.owner === 'string'
      && typeof row.repository.name === 'string' ? { owner: row.repository.owner, name: row.repository.name } : undefined;
    const sources = Array.isArray(row.sources) ? row.sources.flatMap((s): FlowTriggerSource[] =>
      isCloudRecord(s) && typeof s.provider === 'string' && (FLOW_TRIGGER_PROVIDERS as readonly string[]).includes(s.provider)
        ? [{ provider: s.provider as FlowTriggerProvider,
            settings: Object.fromEntries(Object.entries(isCloudRecord(s.settings) ? s.settings : {})
              .flatMap(([k, v]) => typeof v === 'string' ? [[k, v]] : typeof v === 'boolean' ? [[k, String(v)]] : [])) }]
        : []) : [];
    return {
      agentId: row.agentId, name: row.name, status: typeof row.status === 'string' ? row.status : 'unknown',
      ...(repository === undefined ? {} : { repository }), sources,
      ...(typeof row.createdAt === 'string' ? { createdAt: row.createdAt } : {}),
      ...(typeof row.updatedAt === 'string' ? { updatedAt: row.updatedAt } : {}),
    };
  });
}

const LISTENER_ID = /^[A-Za-z0-9_-]{1,128}$/u;

/** `DELETE /api/v1/flows/listeners/<id>`: the listener stops; past runs and their journals stay. */
export async function undeployFromCloud(agentId: string, options: CloudConnectionOptions = {}): Promise<void> {
  if (!LISTENER_ID.test(agentId)) throw new CloudFlowError('invalid_input', `"${agentId}" is not a deployment id.`);
  const result = await cloudFetch(`/api/v1/flows/listeners/${encodeURIComponent(agentId)}`, options, { method: 'DELETE', detail: true });
  if (!isCloudRecord(result) || result.status !== 'deleted') {
    throw new CloudFlowError('invalid_response', 'Cloud did not confirm the deletion.');
  }
}
