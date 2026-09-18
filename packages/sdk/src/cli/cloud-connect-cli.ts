import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parse as parseYaml } from 'yaml';
import { loadAuthoredFlow } from '../authored-flow-loader.js';
import { ensureIntegrationsConnected, type ConnectPrompt, type ConnectionsOutcome } from '../cloud-connect.js';
import { CloudFlowError, cloudRequest, isCloudRecord, type CloudConnectionOptions } from '../cloud-http.js';
import { CompileError, compileSpec, kernelToAuthoring } from '../compile.js';
import { FLOW_HARNESSES, flowRequirements, type FlowRequirements, type FlowRequirementsContext } from '../flow-requirements.js';
import { readProjectConfig } from './check.js';
import type { CliIo } from '../cli.js';

/**
 * The hosted verbs' shared "are the integrations connected?" step. It runs
 * before `flows deploy`, `flows schedule` and `flows run --cloud` submit
 * anything, so a flow that would fail at its first `f.slack.post` with
 * `helper_slack.credential_missing` is connected — or refused — first.
 *
 * The flow is read the same way the submission reads it (authored loader or
 * YAML compile); a source that does not load is left for the submission to
 * refuse with its own, better diagnostic, so this step never masks one.
 */

export interface FlowConnectionsInput extends FlowRequirementsContext {
  path: string;
  /** `undefined` refuses a missing integration instead of prompting (`--no-connect`, `--json`, no TTY). */
  prompt: ConnectPrompt | undefined;
  /** Known already (deploy resolved it); otherwise `whoami` supplies it. */
  workspaceId?: string;
}

export async function flowRequirementsForPath(
  path: string, context: FlowRequirementsContext = {},
): Promise<FlowRequirements | undefined> {
  const projectCli = context.projectCli ?? projectCliFor(path);
  const withCli = { ...context, ...(projectCli === undefined ? {} : { projectCli }) };
  try {
    if (/\.flow\.ts$/iu.test(path)) {
      const loaded = await loadAuthoredFlow(path);
      return flowRequirements(loaded.getDefinition(loaded.handle), withCli);
    }
    if (!/\.(?:ya?ml|json)$/iu.test(path)) return undefined;
    const parsed: unknown = parseYaml(await readFile(path, 'utf8'));
    let spec;
    try {
      spec = compileSpec(parsed);
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
      spec = compileSpec(kernelToAuthoring(parsed));
    }
    return flowRequirements(spec, withCli);
  } catch {
    return undefined;
  }
}

function projectCliFor(path: string): string | undefined {
  try {
    return readProjectConfig(dirname(resolve(path))).cli;
  } catch {
    return undefined;
  }
}

/** `whoami`'s current workspace: the one every hosted verb submits into. */
export async function currentWorkspaceId(options: CloudConnectionOptions): Promise<string> {
  const whoami = await cloudRequest('/api/v1/auth/whoami', options);
  const workspace = isCloudRecord(whoami) && isCloudRecord(whoami.currentWorkspace) ? whoami.currentWorkspace : undefined;
  if (workspace === undefined || typeof workspace.id !== 'string' || !workspace.id) {
    throw new CloudFlowError('invalid_response', 'Cloud did not report a current workspace for this credential.');
  }
  return workspace.id;
}

/**
 * Connects (or refuses on) every integration `path` requires. Nothing is
 * contacted when the flow requires no integration, so a flow with no
 * helpers, sources or repository submits exactly as before; the derived
 * requirements still come back so a later harness refusal can name its remedy.
 * `undefined` only when the source does not load — the submission says why.
 */
export async function ensureFlowConnections(
  input: FlowConnectionsInput, options: CloudConnectionOptions = {},
): Promise<{ requirements: FlowRequirements; outcome: ConnectionsOutcome } | undefined> {
  const requirements = await flowRequirementsForPath(input.path, input);
  if (requirements === undefined) return undefined;
  if (requirements.integrations.length === 0) return { requirements, outcome: { ready: [], connected: [] } };
  const workspaceId = input.workspaceId ?? await currentWorkspaceId(options);
  const outcome = await ensureIntegrationsConnected(requirements, {
    ...options, workspaceId, ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
  });
  return { requirements, outcome };
}

/**
 * A terminal prompt, or nothing. `--json` output is for a machine, and a
 * pipe cannot answer a question, so both refuse instead of asking; `--no-connect`
 * is the explicit form of the same choice.
 */
export function cliConnectPrompt(
  io: CliIo, { noConnect, json }: { noConnect: boolean; json: boolean },
  streams: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream } = { stdin: process.stdin, stdout: process.stdout },
): ConnectPrompt | undefined {
  if (noConnect || json || !streams.stdin.isTTY || !streams.stdout.isTTY) return undefined;
  return {
    info: line => io.stderr(line),
    confirm: question => new Promise(resolveAnswer => {
      const rl = createInterface({ input: streams.stdin, output: streams.stdout });
      rl.question(question, answer => {
        rl.close();
        resolveAnswer(/^\s*(?:y(?:es)?)?\s*$/iu.test(answer));
      });
    }),
  };
}

/**
 * Cloud refuses a run or activation whose coding-agent credential is missing
 * (`flow_model_not_connected`, `cli_credentials_missing`); there is no status
 * route to ask first, so the refusal is where the remedy is named.
 */
export function harnessRemedy(error: unknown, harnesses: readonly string[]): string {
  if (!(error instanceof CloudFlowError) || error.refusal === undefined) return '';
  if (!['flow_model_not_connected', 'cli_credentials_missing'].includes(error.refusal.code)) return '';
  if (/agent-relay cloud connect/u.test(error.refusal.error)) return '';
  const message = error.refusal.error.toLowerCase();
  const named = FLOW_HARNESSES.filter(harness => message.includes(harness));
  const targets = named.length > 0 ? named : harnesses.length > 0 ? harnesses : ['claude'];
  return ` Connect it with: ${targets.map(harness => `agent-relay cloud connect ${harness}`).join('; ')}.`;
}
