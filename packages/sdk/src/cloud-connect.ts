import { spawn } from 'node:child_process';
import { CloudFlowError, cloudFetch, cloudRequest, isCloudRecord, type CloudConnectionOptions } from './cloud-http.js';
import type { FlowIntegrationRequirement, FlowRequirements } from './flow-requirements.js';

/**
 * Integration readiness before a hosted submission — the CLI form of the
 * deploy wizard's "Connect integrations" step, and the same relayfile
 * connect-session flow `agentworkforce deploy` runs for a proactive agent:
 *
 *   GET  /api/v1/workspaces/<id>/integrations/<provider>/status?scope=workspace
 *   POST /api/v1/workspaces/<id>/integrations/connect-session
 *        { allowedIntegrations: [<provider>], scope: { kind: "workspace" } }
 *        → { connectLink } (older: sessionUrl / url), opened in the browser,
 *   then the status is polled until it reports ready.
 *
 * Only `workspace` scope is used: a flow deployment runs as the workspace,
 * which is the scope `checkFlowConnections` reads on the server. Nothing here
 * stores a credential — Cloud's connect page does — and a refusal names the
 * provider and the two ways to connect it (this prompt, or the dashboard).
 */

export interface ConnectPrompt {
  /** Asked once per missing provider before a browser opens; `false` refuses the submission. */
  confirm(question: string): Promise<boolean>;
  info(line: string): void;
  /** Defaults to the platform opener (`open`, `xdg-open`, `start`); a failure only means the URL was printed. */
  openUrl?(url: string): Promise<void> | void;
}

export interface EnsureConnectionsOptions extends CloudConnectionOptions {
  workspaceId: string;
  /** Omitted (`--no-connect`, or no TTY) means a missing integration is a refusal, never a prompt. */
  prompt?: ConnectPrompt;
  /** Status poll cadence while the browser connect is pending. Default 2 seconds. */
  pollIntervalMs?: number;
  /** How long one connect may stay pending. Default 5 minutes. */
  connectTimeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface ConnectionsOutcome {
  /** Providers the workspace already had. */
  ready: string[];
  /** Providers connected through this prompt, in order. */
  connected: string[];
}

interface IntegrationProbe {
  ready: boolean;
  connected: boolean;
  status: Record<string, unknown> | null;
}

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/** Whether the workspace has a ready connection for one provider. */
export async function integrationConnected(
  workspaceId: string, provider: string, options: CloudConnectionOptions,
): Promise<boolean> {
  return (await probeIntegration(workspaceId, provider, options)).ready;
}

async function probeIntegration(
  workspaceId: string, provider: string, options: CloudConnectionOptions,
): Promise<IntegrationProbe> {
  assertIds(workspaceId, provider);
  const base = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations`;
  try {
    const status = await cloudFetch(`${base}/${encodeURIComponent(provider)}/status?scope=workspace`, options,
      { method: 'GET', detail: true });
    return probeFromStatus(status);
  } catch (error) {
    if (!(error instanceof CloudFlowError) || error.code !== 'http_error') throw error;
    if (error.refusal?.code === 'unknown_provider') {
      throw new CloudFlowError('integration_not_connected',
        `"${provider}" is not an integration this Cloud can connect; the flow declares it, so rename the declaration to a provider Cloud lists.`,
        error.status, error.refusal);
    }
    // An older Cloud without the per-provider status route: the list still says which are connected.
    if (error.status !== 404 && error.status !== 405) throw error;
    const list = await cloudRequest(base, options);
    const rows = Array.isArray(list) ? list : isCloudRecord(list) && Array.isArray(list.integrations) ? list.integrations : [];
    const row = rows.find(candidate => isCloudRecord(candidate) && candidate.provider === provider);
    return row === undefined ? { ready: false, connected: false, status: null } : probeFromStatus(row);
  }
}

/**
 * Every integration the requirements name is ready when this resolves; each
 * missing one was connected through the prompt, or the whole submission is
 * refused with `integration_not_connected` naming the first missing provider.
 */
export async function ensureIntegrationsConnected(
  requirements: Pick<FlowRequirements, 'integrations'>, options: EnsureConnectionsOptions,
): Promise<ConnectionsOutcome> {
  const outcome: ConnectionsOutcome = { ready: [], connected: [] };
  for (const integration of requirements.integrations) {
    options.signal?.throwIfAborted();
    const probe = await probeIntegration(options.workspaceId, integration.provider, options);
    if (probe.ready) {
      outcome.ready.push(integration.provider);
      continue;
    }
    if (probe.connected) throw notReady(integration, probe.status);
    if (options.prompt === undefined) throw notConnected(integration, options);
    const label = providerLabel(integration.provider);
    options.prompt.info(`This flow needs ${label} (${integration.detail}), which is not connected to this workspace.`);
    if (!await options.prompt.confirm(`Connect ${label} now? (opens browser) [Y/n] `)) {
      throw notConnected(integration, options);
    }
    await connectIntegration(integration.provider, options, options.prompt);
    outcome.connected.push(integration.provider);
  }
  return outcome;
}

function notReady(integration: FlowIntegrationRequirement, status: Record<string, unknown> | null): CloudFlowError {
  const label = providerLabel(integration.provider);
  const details = readinessDetails(status);
  const configKey = status === null ? undefined : readString(status['configKey']);
  const credential = configKey === undefined ? 'existing credential' : `existing ${configKey} credential`;
  const remedy = integration.provider === 'gitlab' && missingProviderSyncStatus(status)
    ? 'Select the GitLab project in the dashboard integration setup, or re-save the selected project to restart its sync. '
      + 'Keep the existing connection; do not reconnect or switch to OAuth.'
    : `Repair the ${credential} from the dashboard; do not create a second connection.`;
  return new CloudFlowError('integration_not_ready',
    `${label} is connected to this workspace with its ${credential}, but it is not ready for this flow (${integration.detail})`
    + `${details === '' ? '.' : `: ${details}.`} ${remedy}`);
}

async function connectIntegration(provider: string, options: EnsureConnectionsOptions, prompt: ConnectPrompt): Promise<void> {
  const base = `/api/v1/workspaces/${encodeURIComponent(options.workspaceId)}/integrations`;
  const session = await cloudFetch(`${base}/connect-session`, options, {
    method: 'POST', detail: true,
    body: JSON.stringify({ allowedIntegrations: [provider], scope: { kind: 'workspace' } }),
  });
  const url = isCloudRecord(session)
    ? [session.connectLink, session.sessionUrl, session.url].find((value): value is string => typeof value === 'string' && value.length > 0)
    : undefined;
  if (url === undefined || !/^https:\/\//u.test(url)) {
    throw new CloudFlowError('invalid_response', 'Cloud did not return a connect link.');
  }
  prompt.info(`Opening ${url}`);
  prompt.info(`If the browser did not open, visit that link, then return here; waiting for ${providerLabel(provider)} to connect…`);
  try {
    await (prompt.openUrl ?? openInBrowser)(url);
  } catch {
    // The link was printed; the poll below is what decides.
  }
  const interval = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + (options.connectTimeoutMs ?? 300_000);
  const sleep = options.sleep ?? defaultSleep;
  while (Date.now() < deadline) {
    await sleep(interval, options.signal);
    options.signal?.throwIfAborted();
    if (await integrationConnected(options.workspaceId, provider, options)) {
      prompt.info(`${providerLabel(provider)} connected.`);
      return;
    }
  }
  throw new CloudFlowError('integration_not_connected',
    `${providerLabel(provider)} was not connected before the wait ran out. Finish at ${url}, then run the command again.`);
}

function notConnected(integration: FlowIntegrationRequirement, options: EnsureConnectionsOptions): CloudFlowError {
  const label = providerLabel(integration.provider);
  return new CloudFlowError('integration_not_connected',
    `${label} is not connected to this workspace, and this flow needs it (${integration.detail}). `
    + `Connect it from the dashboard, or run again without --no-connect in a terminal to connect it now `
    + `(a browser opens a ${label} connect page for workspace ${options.workspaceId}).`);
}

function isReady(status: unknown): boolean {
  if (!isCloudRecord(status)) return false;
  return status.ready === true || status.state === 'ready' || status.status === 'ready' || status.status === 'connected';
}

function probeFromStatus(status: unknown): IntegrationProbe {
  if (!isCloudRecord(status)) return { ready: false, connected: false, status: null };
  const ready = isReady(status);
  const oauth = isCloudRecord(status['oauth']) ? status['oauth'] : null;
  const connected = ready
    || status['upstreamConnected'] === true
    || status['connectionMatched'] === true
    || readString(status['currentConnectionId']) !== undefined
    || oauth?.['connected'] === true;
  return { ready, connected, status };
}

function readinessDetails(status: Record<string, unknown> | null): string {
  if (status === null) return '';
  const details: string[] = [];
  const state = readString(status['state']) ?? readString(status['status']);
  if (state !== undefined) details.push(`state=${state}`);
  const initialSync = isCloudRecord(status['initialSync']) ? status['initialSync'] : null;
  const syncState = initialSync === null ? undefined : readString(initialSync['state']);
  if (syncState !== undefined) details.push(`initial sync=${syncState}`);
  if (status['ingressHealthy'] === false) details.push('ingress unhealthy');
  const webhookHealth = isCloudRecord(status['webhookHealth']) ? status['webhookHealth'] : null;
  const webhookError = webhookHealth === null ? undefined : readString(webhookHealth['lastError']);
  if (webhookError !== undefined) details.push(`webhook=${webhookError}`);
  return details.join('; ');
}

function missingProviderSyncStatus(status: Record<string, unknown> | null): boolean {
  if (status === null) return false;
  const webhookHealth = isCloudRecord(status['webhookHealth']) ? status['webhookHealth'] : null;
  return webhookHealth !== null
    && readString(webhookHealth['lastError']) === 'No provider sync status is available';
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function assertIds(workspaceId: string, provider: string): void {
  if (!WORKSPACE_ID.test(workspaceId)) throw new CloudFlowError('invalid_response', 'Cloud reported an unusable workspace id.');
  if (!PROVIDER_ID.test(provider)) throw new CloudFlowError('invalid_input', `"${provider}" is not an integration provider id.`);
}

/** `google-mail` → `Google Mail`, `github` → `GitHub`; presentation only. */
export function providerLabel(provider: string): string {
  const known: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab', hubspot: 'HubSpot', clickup: 'ClickUp' };
  return known[provider] ?? provider.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort(): void { clearTimeout(timer); reject(signal!.reason); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Detached so a browser that outlives the CLI never holds its stdio; every
 * failure is ignored. `FLOWS_NO_BROWSER=1` (an SSH session, CI) leaves the
 * printed link as the only opener.
 */
function openInBrowser(url: string): void {
  if (process.env['FLOWS_NO_BROWSER'] === '1') return;
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Printed URL is the fallback.
  }
}
