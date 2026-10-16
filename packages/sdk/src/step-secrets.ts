import type { CliAdapterKind } from './cli-adapter.js';

/** Cloud supplies this name-only manifest alongside delivered envSecrets. */
export const SECRET_ENV_NAMES = 'RELAY_SECRET_ENV_NAMES';
/** CLI-only hosted signal read capability. Never a run or step secret. */
export const SIGNAL_READ_TOKEN_ENV = 'RELAYFLOW_V2_SIGNAL_READ_TOKEN';
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const BASE_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LANGUAGE',
  'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TMP', 'TEMP', 'XDG_RUNTIME_DIR',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'HOSTNAME',
  'NODE_PATH', 'NODE_ENV', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
  'SSL_CERT_DIR', 'NVM_DIR', 'NVM_BIN', 'NVM_INC',
  'NVM_SYMLINK_CURRENT', 'PIPX_HOME', 'PIPX_BIN_DIR', 'PYTHON_PATH',
  'PYTHON_VERSION', 'PYTHON_SHA256', 'RELAYFILE_MOUNT_PATH',
  'RELAYFILE_MOUNT_PATHS', 'RELAYFILE_MOUNT_ROOT', 'WORKSPACE_ROOT',
  'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR',
] as const;

// Model login is an intrinsic capability of the selected CLI. It is not a
// run's delivered envSecret; only that CLI gets its own login variables.
const CLI_LOGIN: Record<CliAdapterKind, readonly string[]> = {
  claude: [
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK',
    'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION',
  ],
  codex: ['CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE'],
  'relayflows-wrapper-v1': [],
};

export function deliveredNames(source: NodeJS.ProcessEnv): ReadonlySet<string> | undefined {
  const raw = source[SECRET_ENV_NAMES];
  if (raw === undefined) return undefined; // self-hosted runs may grant present env names
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${SECRET_ENV_NAMES} must be a JSON array of names`); }
  if (!Array.isArray(parsed) || !parsed.every(name => typeof name === 'string' && VALID_NAME.test(name))) {
    throw new Error(`${SECRET_ENV_NAMES} must be a JSON array of valid names`);
  }
  if (new Set(parsed).size !== parsed.length || parsed.includes(SECRET_ENV_NAMES)
    || parsed.includes(SIGNAL_READ_TOKEN_ENV)) {
    throw new Error(`${SECRET_ENV_NAMES} contains a duplicate or reserved name`);
  }
  return new Set(parsed);
}

/** Refuse a misspelled, unavailable or platform-owned name before a child runs. */
export function validateStepSecrets(declaration: unknown, source: NodeJS.ProcessEnv): string[] {
  const known = deliveredNames(source);
  if (declaration === undefined) return [];
  if (!Array.isArray(declaration) || !declaration.every(name => typeof name === 'string' && VALID_NAME.test(name))) {
    throw new Error('step secrets must be an array of environment variable names');
  }
  const names = declaration as string[];
  if (new Set(names).size !== names.length) throw new Error('step secrets contain duplicate names');
  for (const name of names) {
    if (name === SECRET_ENV_NAMES || name === SIGNAL_READ_TOKEN_ENV
      || !Object.hasOwn(source, name) || typeof source[name] !== 'string'
      || (known !== undefined && !known.has(name))) {
      throw new Error(`step secret ${JSON.stringify(name)} is not available to this run`);
    }
  }
  return [...names];
}

/** One provider CLI starts from an allowlist, then receives only its grants. */
export function agentStepEnvironment(
  source: NodeJS.ProcessEnv,
  kind: CliAdapterKind,
  declaration?: unknown,
): NodeJS.ProcessEnv {
  const known = deliveredNames(source);
  const grants = validateStepSecrets(declaration, source);
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...BASE_ENV, ...CLI_LOGIN[kind]]) {
    if (known?.has(name) && !grants.includes(name)) continue;
    if (source[name] !== undefined) env[name] = source[name];
  }
  for (const name of grants) env[name] = source[name];
  return env;
}
