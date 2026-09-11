import { statSync } from 'node:fs';
import { join } from 'node:path';
import { helperProviders } from '@relayflows/surface/runtime';
import { preflightHelpers } from './preflight.js';

export function providerMount(provider: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = [env.RELAYFILE_MOUNT_PATH, env.WORKSPACE_ROOT, env.WORKFORCE_SANDBOX_ROOT,
    env.RELAYFILE_MOUNT_ROOT, env.RELAYFILE_ROOT].find(value => value?.trim());
  if (!root?.trim()) return undefined;
  try { return statSync(join(root, provider)).isDirectory() ? root : undefined; }
  catch { return undefined; }
}

export const slackMount = (env: NodeJS.ProcessEnv = process.env) => providerMount('slack', env);

export function checkProviderHelpers(definition: Parameters<typeof preflightHelpers>[0]) {
  return preflightHelpers(definition, {
    providers: Object.fromEntries(helperProviders.map(p => [p.provider, {
      mount: providerMount(p.provider) !== undefined,
      mock: process.env[p.mockEnv] === '1',
      token: p.provider === 'slack' ? process.env.SLACK_BOT_TOKEN : undefined,
    }])),
  });
}
export const checkSlackHelpers = checkProviderHelpers;
