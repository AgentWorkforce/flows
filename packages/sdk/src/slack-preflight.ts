import { statSync } from 'node:fs';
import { join } from 'node:path';
import { preflightHelpers } from './preflight.js';

export function slackMount(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = [env.RELAYFILE_MOUNT_PATH, env.WORKSPACE_ROOT, env.WORKFORCE_SANDBOX_ROOT,
    env.RELAYFILE_MOUNT_ROOT, env.RELAYFILE_ROOT].find(value => value?.trim());
  if (!root?.trim()) return undefined;
  try { return statSync(join(root, 'slack')).isDirectory() ? root : undefined; }
  catch { return undefined; }
}

export function checkSlackHelpers(definition: Parameters<typeof preflightHelpers>[0]) {
  return preflightHelpers(definition, {
    slackToken: process.env.SLACK_BOT_TOKEN,
    slackMount: slackMount() !== undefined,
    slackMock: process.env.RELAYFLOWS_SLACK_MOCK === '1',
  });
}
