import { createHash } from 'node:crypto';
import { ensureIntegrationsConnected, type ConnectPrompt } from './cloud-connect.js';
import {
  CloudFlowError, cloudFetch, cloudRequest, isCloudRecord, type CloudConnectionOptions,
} from './cloud-http.js';
import {
  FLOW_AGENT_HARNESSES, listCloudDeployments, loadDeploySource, type DeployRepository, type FlowTriggerSource,
} from './cloud-deploy.js';
import {
  parseVersion, parseVersionChange, type CloudFlowVersion, type CloudFlowVersionChange,
} from './cloud-versions-wire.js';
import { flowRequirements, mergeFlowExtensionRequirements, type FlowRequirements } from './flow-requirements.js';

/**
 * Versions of a hosted listener (AgentWorkforce/cloud#4115). A deployed
 * flow's source is immutable: `flows deploy <file> --flow <name-or-id>` makes
 * the next version and moves the listener's pointer to it, leaving the
 * listener's repository, triggers, approver, agents and run budget untouched;
 * `flows rollback` moves the pointer to any recorded version.
 */

const LISTENER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface CloudListener {
  agentId: string;
  name: string;
  status: string;
  repository: DeployRepository;
  sources: FlowTriggerSource[];
  activeVersion: CloudFlowVersion | null;
  versions: CloudFlowVersion[];
}

/** A listener id as given, else the one deployment in the workspace with that name. */
export async function resolveCloudFlow(flow: string, options: CloudConnectionOptions = {}): Promise<string> {
  const wanted = flow.trim();
  if (!wanted) throw new CloudFlowError('invalid_input', '--flow needs a flow name or listener id.');
  if (LISTENER_UUID.test(wanted)) return wanted.toLowerCase();
  const deployments = await listCloudDeployments(options);
  // Any listener id the workspace lists, before names: ids are not all uuids.
  const byId = deployments.find(deployment => deployment.agentId === wanted);
  if (byId) return byId.agentId;
  const matches = deployments.filter(deployment => deployment.name.toLowerCase() === wanted.toLowerCase());
  if (matches.length === 1) return matches[0]!.agentId;
  if (matches.length === 0) {
    throw new CloudFlowError('invalid_input', `No flow named "${wanted}" in this workspace; list them with: flows deployments`);
  }
  throw new CloudFlowError('invalid_input',
    `More than one flow is named "${wanted}" (${matches.map(match => match.agentId).join(', ')}); pass the listener id.`);
}

export async function getCloudListener(agentId: string, options: CloudConnectionOptions = {}): Promise<CloudListener> {
  const payload = await cloudRequest(`/api/v1/flows/listeners/${encodeURIComponent(agentId)}`, options);
  const listener = isCloudRecord(payload) && isCloudRecord(payload.listener) ? payload.listener : undefined;
  if (!listener || typeof listener.name !== 'string' || typeof listener.status !== 'string'
    || !isCloudRecord(listener.repository) || typeof listener.repository.owner !== 'string'
    || typeof listener.repository.name !== 'string' || !Array.isArray(listener.sources)) {
    throw new CloudFlowError('invalid_response', 'Cloud did not return the flow listener.');
  }
  const versions = isCloudRecord(payload) && Array.isArray(payload.versions)
    ? payload.versions.flatMap(entry => parseVersion(entry) ?? []) : [];
  return {
    agentId,
    name: listener.name,
    status: listener.status,
    repository: {
      owner: listener.repository.owner, name: listener.repository.name,
      ...(listener.repository.host === 'gitlab' ? { host: 'gitlab' as const } : {}),
    },
    sources: listener.sources.flatMap((entry): FlowTriggerSource[] => isCloudRecord(entry) && typeof entry.provider === 'string'
      ? [{ provider: entry.provider as FlowTriggerSource['provider'],
          settings: Object.fromEntries(Object.entries(isCloudRecord(entry.settings) ? entry.settings : {})
            .flatMap(([key, value]) => typeof value === 'string' ? [[key, value]] : typeof value === 'boolean' ? [[key, String(value)]] : [])) }]
      : []),
    activeVersion: isCloudRecord(payload) ? parseVersion(payload.activeVersion) ?? null : null,
    versions,
  };
}

export interface DeployVersionInput {
  path: string;
  /** The flow's deployed name or its listener id. */
  flow: string;
  plugins?: readonly string[];
  connect?: ConnectPrompt;
  checkConnections?: boolean;
}

export interface CloudVersionDeployment {
  agentId: string;
  name: string;
  status: string;
  sourceSha256: string;
  requirements: FlowRequirements;
  connected: string[];
  version: CloudFlowVersionChange;
}

/** `POST /api/v1/flows/listeners/<id>/versions`: the source alone becomes the next version. */
export async function deployVersionToCloud(
  input: DeployVersionInput, options: CloudConnectionOptions = {},
): Promise<CloudVersionDeployment> {
  const { bytes, source, definition, extensions, projectCli } = await loadDeploySource(input);
  const agentId = await resolveCloudFlow(input.flow, options);
  const listener = await getCloudListener(agentId, options);
  options.signal?.throwIfAborted();
  // Requirements derive from the source, read against the listener's own
  // repository and triggers, exactly as the create form reads its flags.
  const requirements = mergeFlowExtensionRequirements(
    flowRequirements(definition, {
      sources: listener.sources,
      // A GitHub repository means every run needs GitHub; a GitLab project does not.
      ...(listener.repository.host === 'gitlab' ? {} : { repository: listener.repository }),
      ...(projectCli === undefined ? {} : { projectCli }),
    }),
    extensions.map(extension => ({ name: extension.name, permissions: extension.manifest.permissions })),
  );
  // As on create: a harness Cloud cannot run is refused here, not deployed.
  // There is no --agents override beside --flow; the listener's agents stay.
  const unsupported = requirements.harnessUses
    .filter(use => !(FLOW_AGENT_HARNESSES as readonly string[]).includes(use.harness));
  if (unsupported.length > 0) {
    throw new CloudFlowError('unsupported_source',
      `This flow declares ${unsupported.map(use => `${use.harness} (${use.detail})`).join(', ')}, which Cloud deployments cannot run yet; `
      + `Cloud runs ${FLOW_AGENT_HARNESSES.join(' and ')}. Change the declaration before deploying a new version.`);
  }
  const whoami = await cloudRequest('/api/v1/auth/whoami', options);
  const workspace = isCloudRecord(whoami) && isCloudRecord(whoami.currentWorkspace) ? whoami.currentWorkspace : undefined;
  if (workspace === undefined || typeof workspace.id !== 'string' || !workspace.id) {
    throw new CloudFlowError('invalid_response', 'Cloud did not report a current workspace for this credential.');
  }
  // A draft activates nothing, so Cloud checks nothing; match it here.
  const connected = listener.status !== 'listening' || input.checkConnections === false
    ? []
    : (await ensureIntegrationsConnected(requirements, {
        ...options, workspaceId: workspace.id, ...(input.connect === undefined ? {} : { prompt: input.connect }),
      })).connected;
  options.signal?.throwIfAborted();
  const result = await cloudFetch(`/api/v1/flows/listeners/${encodeURIComponent(agentId)}/versions`, options, {
    method: 'POST', detail: true, body: JSON.stringify({
      workspaceId: workspace.id,
      source,
      requirements: {
        integrations: requirements.integrations.map(integration => integration.provider),
        harnesses: requirements.harnesses,
        mcp: requirements.mcp,
      },
      ...(extensions.length === 0 ? {} : { extensions }),
    }),
  });
  const version = isCloudRecord(result) ? parseVersionChange(result.version) : undefined;
  if (!isCloudRecord(result) || typeof result.status !== 'string' || version === undefined) {
    throw new CloudFlowError('invalid_response', 'Cloud did not return the new flow version.');
  }
  return {
    agentId, name: listener.name, status: result.status,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    requirements, connected, version,
  };
}

/** `POST /api/v1/flows/listeners/<id>/versions/<n>/activate`: history is kept; only the pointer moves. */
export async function activateCloudFlowVersion(
  flow: string, version: number, options: CloudConnectionOptions = {},
): Promise<{ agentId: string; status: string; version: CloudFlowVersionChange }> {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new CloudFlowError('invalid_input', `A version is a positive whole number, got "${version}".`);
  }
  const agentId = await resolveCloudFlow(flow, options);
  const result = await cloudFetch(
    `/api/v1/flows/listeners/${encodeURIComponent(agentId)}/versions/${version}/activate`,
    options, { method: 'POST', detail: true },
  );
  const change = isCloudRecord(result) ? parseVersionChange(result.version) : undefined;
  if (!isCloudRecord(result) || typeof result.status !== 'string' || change === undefined) {
    throw new CloudFlowError('invalid_response', 'Cloud did not confirm the active version.');
  }
  return { agentId, status: result.status, version: change };
}
