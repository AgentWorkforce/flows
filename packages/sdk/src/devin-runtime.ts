import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliInvocation } from './adapters/base.js';

/** Private attempt/probe state, never the user's interactive Devin login. */
export function prepareDevinRuntime(environment: NodeJS.ProcessEnv, invocation?: CliInvocation) {
  let root: string | undefined;
  const env = { ...environment };
  const args = [...(invocation?.args ?? [])];
  const directory = () => root ??= mkdtempSync(join(environment.TMPDIR ?? tmpdir(), 'relayflows-devin-'));
  const close = () => { if (root !== undefined) rmSync(root, { recursive: true, force: true }); };
  try {
    if (env.DEVIN_API_KEY !== undefined) {
      if (!env.DEVIN_API_KEY.trim()) throw new Error('DEVIN_API_KEY must not be empty');
      const data = join(directory(), 'data');
      mkdirSync(join(data, 'devin'), { recursive: true, mode: 0o700 });
      writeFileSync(join(data, 'devin', 'credentials.toml'),
        `windsurf_api_key = ${JSON.stringify(env.DEVIN_API_KEY)}\n`, { mode: 0o600 });
      env.XDG_DATA_HOME = data;
      env.XDG_CONFIG_HOME = join(directory(), 'config');
      env.XDG_CACHE_HOME = join(directory(), 'cache');
      delete env.DEVIN_API_KEY;
    }
    if (invocation?.promptFile !== undefined) {
      const path = join(directory(), 'prompt.txt');
      writeFileSync(path, invocation.promptFile, { mode: 0o600 });
      args.push('--prompt-file', path);
    }
    return { env, args, close };
  } catch (error) { close(); throw error; }
}
