import { basename } from 'node:path';
import { wrapperEnvironment } from '../wrapper-runtime.js';

const terminalNames = ['TERM', 'COLORTERM', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'];
const relayNames = ['RELAY_API_KEY', 'RELAY_WORKSPACE_KEY', 'AGENT_RELAY_WORKSPACE_KEY',
  'RELAY_BROKER_API_KEY', 'RELAY_AGENT_TOKEN', 'RELAY_NODE_TOKEN', 'RELAY_WORKSPACES_JSON'];
const providerNames: Record<string, string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'],
  codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'],
  'cursor-agent': ['CURSOR_API_KEY'],
  droid: ['FACTORY_API_KEY'],
  grok: ['XAI_API_KEY'],
};
// Multi-provider CLIs select their provider in their own configuration.
const multiProvider = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY'];
for (const cli of ['opencode', 'aider', 'goose', 'pi', 'deepagents']) providerNames[cli] = multiProvider;
function selected(source: NodeJS.ProcessEnv, names: string[]) {
  return Object.fromEntries(names.filter(name => source[name] !== undefined).map(name => [name, source[name]]));
}
export function brokerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // The driver merges its parent's env before options.env. Undefined explicitly
  // removes inherited keys when Node spawns the child; omission would leak them.
  return { ...Object.fromEntries(Object.keys(source).map(name => [name, undefined])),
    ...wrapperEnvironment(source), ...selected(source, [...terminalNames, 'RELAY_BASE_URL']) };
}
export function agentEnvironment(cli: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  // Broker transport credentials must not become CLI credentials. The harness
  // protocol accepts string values, so clear those inherited names explicitly.
  return { ...Object.fromEntries(relayNames.map(name => [name, ''])),
    ...selected(source, providerNames[basename(cli).replace(/\.exe$/i, '')] ?? []) } as Record<string, string>;
}
