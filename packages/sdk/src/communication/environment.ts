import { basename } from 'node:path';
import { wrapperEnvironment } from '../wrapper-runtime.js';
import { deliveredNames, platformAgentNames, repositoryEnvironmentNames, validateStepSecrets } from '../step-secrets.js';

const terminalNames = ['TERM', 'COLORTERM', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'];
const networkNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
const relayNames = ['RELAY_API_KEY', 'RELAY_WORKSPACE_KEY', 'AGENT_RELAY_WORKSPACE_KEY',
  'RELAY_BROKER_API_KEY', 'RELAY_AGENT_TOKEN', 'RELAY_NODE_TOKEN', 'RELAY_WORKSPACES_JSON'];
// Multi-provider CLIs select their provider in their own configuration.
const multiProvider = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY'] as const;
const providerNames: Readonly<Record<string, readonly string[]>> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_USE_BEDROCK', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION'],
  codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'],
  // AgentWorkforce/cloud#4026 passes both endpoint names unchanged as aliases
  // for one run-scoped House proxy base. Dropping either can let a compatible
  // Cursor version fall back to its provider default and bypass the House route.
  'cursor-agent': ['CURSOR_API_KEY', 'CURSOR_API_ENDPOINT', 'CURSOR_API_BASE_URL'],
  droid: ['FACTORY_API_KEY'],
  // AgentWorkforce/cloud#4026's house-provider run contract gives Grok an
  // isolated home plus an xAI-compatible base URL. These remain Grok-scoped.
  grok: ['XAI_API_KEY', 'GROK_XAI_API_BASE_URL', 'GROK_HOME'],
  ...Object.fromEntries(['opencode', 'aider', 'goose', 'pi', 'deepagents'].map(cli => [cli, multiProvider])),
};
/** @internal Names-only test seam; credential lists remain private. */
export function providerEnvironmentCliNames(): readonly string[] { return Object.keys(providerNames); }
function selected(source: NodeJS.ProcessEnv, names: readonly string[]) {
  return Object.fromEntries(names.filter(name => source[name] !== undefined).map(name => [name, source[name]]));
}
export function brokerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // The driver merges its parent's env before options.env. Undefined explicitly
  // removes inherited keys when Node spawns the child; omission would leak them.
  return { ...Object.fromEntries(Object.keys(source).map(name => [name, undefined])),
    ...wrapperEnvironment(source), ...selected(source, [...terminalNames, 'RELAY_BASE_URL']) };
}
export function agentEnvironment(cli: string, source: NodeJS.ProcessEnv = process.env,
  grants?: string[], scopeSecrets = true): Record<string, string> {
  // Broker transport credentials must not become CLI credentials. The harness
  // protocol accepts string values, so clear those inherited names explicitly.
  const cliName = basename(cli).replace(/\.exe$/i, '');
  const credentials = { ...selected(source, providerNames[cliName] ?? []),
    ...selected(source, [...repositoryEnvironmentNames(source), ...networkNames]) };
  if (!scopeSecrets) {
    if (grants?.length) throw new Error('per-step secret grants require a daemon with step_secret_scoping support');
    return { ...Object.fromEntries(relayNames.map(name => [name, ''])), ...credentials } as Record<string, string>;
  }
  const names = deliveredNames(source);
  const platform = platformAgentNames(source, cliName);
  const allowed = validateStepSecrets(grants, source);
  if (allowed.some(name => relayNames.includes(name))) {
    throw new Error('Relay broker credentials cannot be granted to a communication agent');
  }
  for (const name of names ?? []) {
    if (!allowed.includes(name) && !platform.has(name)) delete credentials[name];
  }
  return { ...Object.fromEntries(relayNames.map(name => [name, ''])),
    ...credentials, ...selected(source, allowed) } as Record<string, string>;
}
