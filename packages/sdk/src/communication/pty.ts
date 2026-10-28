import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { agentEnvironment } from './environment.js';
import { resolveCliModel } from '../cli-adapter.js';
import type { RelayBroker } from './relay.js';

export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

/** Both communication steps and retained sessions use Relay's PTY launch contract. */
export async function spawnFlowPty(broker: Pick<RelayBroker, 'spawnPty'>, options: {
  name: string; cli: string; identity?: string; model?: string; task: string;
  skipRelayPrompt?: boolean;
  cwd: string; dataDir: string; channels: string[]; team?: string;
  environment?: NodeJS.ProcessEnv; socket: string; token: string;
  secrets?: string[]; scopeSecrets?: boolean;
  metadata?: { runId: string; flow: string; step: string };
}) {
  const identity = options.identity ?? options.cli;
  const argv0 = basename(identity);
  let command = options.cli;
  let link: string | undefined;
  try {
    if (basename(command) !== argv0) {
      const root = join(options.dataDir, 'communication');
      await mkdir(root, { recursive: true, mode: 0o700 });
      link = await mkdtemp(join(root, 'cli-'));
      command = join(link, argv0);
      await symlink(options.cli, command, 'file');
    }
    const handle = await broker.spawnPty({ name: options.name, cli: argv0.replace(/\.exe$/i, ''),
      task: options.task, channels: options.channels, skipRelayPrompt: options.skipRelayPrompt ?? true,
      ...(options.team === undefined ? {} : { team: options.team }),
      model: resolveCliModel(identity, options.model), cwd: options.cwd,
      harnessConfig: { runtime: 'pty', command: shellQuote(command), args: [], cwd: options.cwd,
        env: { ...agentEnvironment(identity, options.environment ?? process.env,
          options.secrets, options.scopeSecrets ?? true),
          RELAYFLOW_COMMUNICATION_SOCKET: options.socket, RELAYFLOW_COMMUNICATION_TOKEN: options.token,
          ...(options.metadata === undefined ? {} : {
            RELAYFLOW_RUN_ID: options.metadata.runId, RELAYFLOW_FLOW_NAME: options.metadata.flow,
            RELAYFLOW_STEP_NAME: options.metadata.step,
          }) }, delivery: { mode: 'pty-injection', format: 'relay-block' } } });
    return { handle, close: async () => { if (link) await rm(link, { recursive: true, force: true }); } };
  } catch (error) {
    if (link) await rm(link, { recursive: true, force: true });
    throw error;
  }
}
