import { CloudFlowError, cloudFetch, cloudRequest, isCloudRecord, type CloudConnectionOptions } from './cloud-http.js';

const FLOW_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const LABEL_MAX_LENGTH = 100;

export interface RecommendedFlowInputs {
  required: string[];
  defaults: Record<string, unknown>;
  allowedAgents: string[];
}

/** Immutable provenance for a catalog flow; the CLI never fetches or copies it. */
export interface RecommendedFlowSource {
  kind: 'github';
  owner: string;
  repo: string;
  path: string;
  /** Full released Git commit SHA, never a mutable branch such as main. */
  ref: string;
  url: string;
  rawUrl: string;
  release: string;
  mediaType: string;
  sha256: string;
}

export interface RecommendedFlowSummary {
  id: string;
  version: number;
  name: string;
  summary: string;
  description: string;
  source: RecommendedFlowSource;
  defaultLabel: string;
  supportedRepositoryHosts: string[];
  defaultTrigger: { provider: string; settings: Record<string, string> };
  inputs: RecommendedFlowInputs;
}

export type RecommendedFlowDetail = RecommendedFlowSummary;

export interface RecommendedFlowCatalog {
  schemaVersion: number;
  catalogVersion: number;
  flows: RecommendedFlowSummary[];
}

/** Public catalog transport: deliberately separate from authenticated Cloud APIs. */
export interface CatalogConnectionOptions {
  /** Catalog origin, defaulting to https://agentrelay.com; HTTP is loopback-only for local tests. */
  catalogUrl?: string;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
}

export interface RecommendedRepository {
  owner: string;
  name: string;
  host?: 'gitlab';
}

export interface RecommendedFlowActivationInput {
  flowId: string;
  label: string;
  repositories: RecommendedRepository[];
  approver: string;
}

export interface RecommendedFlowActivation {
  activationId: string;
  flowId: string;
  label: string;
  status: string;
  repositories: RecommendedRepository[];
  listeners: { agentId: string; repository: RecommendedRepository; status: string }[];
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? [...value] : undefined;
}

function repository(value: unknown): RecommendedRepository | undefined {
  if (!isCloudRecord(value) || typeof value.owner !== 'string' || typeof value.name !== 'string') return undefined;
  if (value.host !== undefined && value.host !== 'gitlab') return undefined;
  return { owner: value.owner, name: value.name, ...(value.host === 'gitlab' ? { host: 'gitlab' as const } : {}) };
}

function flow(value: unknown): RecommendedFlowSummary {
  const source = isCloudRecord(value) ? value.source : undefined;
  if (!isCloudRecord(value)
    || !FLOW_ID.test(String(value.id ?? ''))
    || !Number.isSafeInteger(value.version) || (value.version as number) < 1
    || !['name', 'summary', 'description', 'defaultLabel'].every(key => typeof value[key] === 'string')
    || !isCloudRecord(value.defaultTrigger) || typeof value.defaultTrigger.provider !== 'string' || !isCloudRecord(value.defaultTrigger.settings)
    || !isCloudRecord(value.inputs) || !isCloudRecord(source)) {
    throw new CloudFlowError('invalid_response', 'Cloud returned a malformed recommended-flow entry.');
  }
  const hosts = stringArray(value.supportedRepositoryHosts);
  const required = stringArray(value.inputs.required);
  const allowedAgents = stringArray(value.inputs.allowedAgents);
  if (hosts === undefined || required === undefined || allowedAgents === undefined || !isCloudRecord(value.inputs.defaults)
    || !Object.values(value.defaultTrigger.settings).every(setting => typeof setting === 'string')
    || source.kind !== 'github'
    || !['owner', 'repo', 'path', 'release', 'ref', 'url', 'rawUrl', 'mediaType', 'sha256'].every(key => typeof source[key] === 'string')
    || !/^[a-f0-9]{40}$/iu.test(source.ref as string)
    || !/^[a-f0-9]{64}$/iu.test(source.sha256 as string)) {
    throw new CloudFlowError('invalid_response', 'Cloud returned malformed recommended-flow metadata.');
  }
  return {
    id: value.id as string, version: value.version as number, name: value.name as string, summary: value.summary as string,
    description: value.description as string,
    defaultLabel: value.defaultLabel as string, supportedRepositoryHosts: hosts,
    defaultTrigger: { provider: value.defaultTrigger.provider, settings: value.defaultTrigger.settings as Record<string, string> },
    inputs: { required, defaults: value.inputs.defaults, allowedAgents },
    source: source as unknown as RecommendedFlowSource,
  };
}

function flowId(value: string): string {
  if (!FLOW_ID.test(value)) throw new CloudFlowError('invalid_input', `"${value}" is not a recommended-flow id.`);
  return value;
}

export async function listRecommendedFlows(options: CatalogConnectionOptions = {}): Promise<RecommendedFlowCatalog> {
  const result = await catalogFetch('/api/v1/flows/catalog', options);
  if (!isCloudRecord(result) || result.schemaVersion !== 1 || !Number.isSafeInteger(result.catalogVersion) || !Array.isArray(result.flows)) {
    throw new CloudFlowError('invalid_response', 'Cloud did not return a recommended-flow catalog.');
  }
  return { schemaVersion: 1, catalogVersion: result.catalogVersion as number, flows: result.flows.map(flow) };
}

export async function getRecommendedFlow(id: string, options: CatalogConnectionOptions = {}): Promise<RecommendedFlowDetail> {
  const result = await catalogFetch(`/api/v1/flows/catalog/${encodeURIComponent(flowId(id))}`, options);
  const parsed = flow(result);
  if (parsed.id !== id) throw new CloudFlowError('invalid_response', 'Cloud returned a different recommended flow than requested.');
  return parsed;
}

function catalogBaseUrl(options: CatalogConnectionOptions): string {
  let url: URL;
  try {
    url = new URL(options.catalogUrl ?? process.env['FLOWS_CATALOG_URL'] ?? 'https://agentrelay.com');
  } catch {
    throw new CloudFlowError('configuration', 'FLOWS_CATALOG_URL must be an absolute catalog origin.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new CloudFlowError('configuration', 'Catalog URL must be an HTTPS origin (HTTP is allowed only on literal loopback).');
  }
  return url.origin;
}

/** Fetch public catalog metadata without reading, requiring, or sending Cloud credentials. */
async function catalogFetch(path: string, options: CatalogConnectionOptions): Promise<unknown> {
  const timeout = options.requestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
    throw new CloudFlowError('configuration', 'requestTimeoutMs must be a positive 32-bit integer.');
  }
  // Configuration failures must remain configuration failures; do not fold
  // them into the transport catch below.
  const baseUrl = catalogBaseUrl(options);
  const deadline = AbortSignal.timeout(timeout);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: 'GET', headers: { accept: 'application/json' },
      signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
      redirect: 'error',
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    throw new CloudFlowError('transport_error', deadline.aborted
      ? 'Catalog request timed out.' : 'Catalog request failed; check TLS and the configured URL.');
  }
  if (!response.ok) throw new CloudFlowError('http_error', `Catalog request failed with HTTP ${response.status}.`, response.status);
  try {
    return await response.json();
  } catch {
    throw new CloudFlowError('invalid_response', 'Catalog returned a non-JSON response.');
  }
}

export async function activateRecommendedFlow(
  input: RecommendedFlowActivationInput, options: CloudConnectionOptions = {},
): Promise<RecommendedFlowActivation> {
  const id = flowId(input.flowId);
  const label = input.label.trim();
  const approver = input.approver.trim();
  if (!label || label.length > LABEL_MAX_LENGTH) throw new CloudFlowError('invalid_input', `--label must be 1-${LABEL_MAX_LENGTH} characters.`);
  if (!approver) throw new CloudFlowError('invalid_input', '--approver must name who approves Software Garden questions.');
  if (input.repositories.length === 0) throw new CloudFlowError('invalid_input', 'Give one or more --repository <owner>/<name> values.');
  const keys = input.repositories.map(repo => `${repo.host ?? 'github'}:${repo.owner}/${repo.name}`);
  if (new Set(keys).size !== keys.length) throw new CloudFlowError('invalid_input', 'Each --repository must be unique.');
  const whoami = await cloudRequest('/api/v1/auth/whoami', options);
  const workspace = isCloudRecord(whoami) && isCloudRecord(whoami.currentWorkspace) ? whoami.currentWorkspace : undefined;
  if (workspace === undefined || typeof workspace.id !== 'string' || !workspace.id) {
    throw new CloudFlowError('invalid_response', 'Cloud did not report a current workspace for this credential.');
  }
  const result = await cloudFetch('/api/v1/flows/activations', options, { method: 'POST', detail: true, body: JSON.stringify({
    workspaceId: workspace.id, flowId: id, label, repositories: input.repositories,
    inputs: { approver },
  }) });
  if (!isCloudRecord(result) || typeof result.activationId !== 'string' || typeof result.flowId !== 'string'
    || typeof result.label !== 'string' || typeof result.status !== 'string' || !Array.isArray(result.repositories)
    || !Array.isArray(result.listeners)) {
    throw new CloudFlowError('invalid_response', 'Cloud did not return a recommended-flow activation.');
  }
  const repositories = result.repositories.map(repository);
  const listeners = result.listeners.map(listener => {
    if (!isCloudRecord(listener) || typeof listener.agentId !== 'string' || typeof listener.status !== 'string') return undefined;
    const listenerRepository = repository(listener.repository);
    return listenerRepository === undefined ? undefined : { agentId: listener.agentId, repository: listenerRepository, status: listener.status };
  });
  if (repositories.some(repo => repo === undefined) || listeners.some(listener => listener === undefined)) {
    throw new CloudFlowError('invalid_response', 'Cloud returned malformed recommended-flow activation records.');
  }
  return { activationId: result.activationId, flowId: result.flowId, label: result.label, status: result.status,
    repositories: repositories as RecommendedRepository[], listeners: listeners as RecommendedFlowActivation['listeners'] };
}
