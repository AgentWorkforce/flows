import { CloudFlowError } from '../cloud-http.js';
import {
  activateCloudFlowVersion, deployVersionToCloud, getCloudListener, resolveCloudFlow,
} from '../cloud-versions.js';
import { describeVersionChange } from '../cloud-versions-wire.js';
import { describeFlowRequirements } from '../flow-requirements.js';
import { cliConnectPrompt } from './cloud-connect-cli.js';
import { reportCloudFailure, type CloudDeployArgs } from './cloud-deploy.js';
import type { CliIo } from '../cli.js';

/**
 * `flows deploy <flow.ts> --flow <name-or-id>`: the source becomes the next
 * version of that flow. Listener settings are not part of a version, so a
 * flag that would change one is refused by name instead of being dropped.
 */
export async function runCloudDeployVersionCli(
  args: CloudDeployArgs & { flow: string }, io: CliIo,
): Promise<0 | 1 | 2> {
  try {
    const settings = [
      args.repo === undefined ? undefined : '--repo',
      args.on.length === 0 ? undefined : '--on',
      args.approver === undefined ? undefined : '--approver',
      args.name === undefined ? undefined : '--name',
      args.agents === undefined ? undefined : '--agents',
      args.draft ? '--draft' : undefined,
    ].filter((flag): flag is string => flag !== undefined);
    if (settings.length > 0) {
      throw new CloudFlowError('invalid_input',
        `--flow deploys a new version of the flow's source only; ${settings.join(', ')} stay on the listener. `
        + 'Drop them, or change them in the Cloud dashboard.');
    }
    const connect = cliConnectPrompt(io, { noConnect: args.noConnect, json: args.json });
    const deployment = await deployVersionToCloud({
      path: args.value,
      flow: args.flow,
      ...(connect === undefined ? {} : { connect }),
      ...(args.plugins.length === 0 ? {} : { plugins: args.plugins }),
    });
    if (args.json) {
      io.stdout(JSON.stringify({ ok: true, ...deployment }));
      return 0;
    }
    io.stdout(`${deployment.status === 'draft' ? 'SAVED' : 'DEPLOYED'} ${deployment.agentId} ${deployment.status}`
      + ` · ${describeVersionChange(deployment.version)}`);
    io.stdout(`  flow: ${deployment.name} (${args.value}, sha256 ${deployment.sourceSha256.slice(0, 12)})`);
    const requires = describeFlowRequirements(deployment.requirements);
    if (requires) io.stdout(`  requires: ${requires}`);
    for (const provider of deployment.connected) io.stdout(`  connected: ${provider}`);
    io.stdout('New runs launch this version; runs already started finish on theirs. History: flows versions '
      + JSON.stringify(deployment.name));
    return 0;
  } catch (error) {
    return reportCloudFailure(error, args.json, io);
  }
}

/** `flows versions <name-or-id>`: newest first, the active one marked. */
export async function runCloudVersionsCli(
  { flow, json }: { flow: string; json: boolean }, io: CliIo,
): Promise<0 | 1 | 2> {
  try {
    const listener = await getCloudListener(await resolveCloudFlow(flow));
    if (json) {
      io.stdout(JSON.stringify({
        ok: true, agentId: listener.agentId, name: listener.name,
        activeVersion: listener.activeVersion?.version ?? null, versions: listener.versions,
      }));
      return 0;
    }
    if (listener.versions.length === 0) {
      io.stdout(`${listener.agentId} ${JSON.stringify(listener.name)} has no recorded versions.`);
      return 0;
    }
    io.stdout(`${listener.agentId} ${JSON.stringify(listener.name)} ${listener.status}`);
    for (const version of listener.versions) {
      const active = version.version === listener.activeVersion?.version ? ' (active)' : '';
      io.stdout(`  version ${version.version}${active}  ${version.createdAt}  ${version.origin}  sha256 ${version.sourceSha256.slice(0, 12)}`);
    }
    return 0;
  } catch (error) {
    return reportCloudFailure(error, json, io);
  }
}

/** `flows rollback <name-or-id> <version>`: move the pointer; later versions stay recorded. */
export async function runCloudRollbackCli(
  { flow, version, json }: { flow: string; version: string; json: boolean }, io: CliIo,
): Promise<0 | 1 | 2> {
  try {
    if (!/^[1-9][0-9]*$/u.test(version)) {
      throw new CloudFlowError('invalid_input', `A version is a positive whole number, got "${version}".`);
    }
    const result = await activateCloudFlowVersion(flow, Number(version));
    io.stdout(json
      ? JSON.stringify({ ok: true, ...result })
      : `ACTIVATED ${result.agentId} ${result.status} · ${describeVersionChange(result.version)}`);
    return 0;
  } catch (error) {
    return reportCloudFailure(error, json, io);
  }
}
