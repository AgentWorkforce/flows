import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/** Read-only SDK connection probe: never starts a broker or an agent harness. */
export function checkBrokerEnvironment(cwd = process.cwd()): void {
  let driver: string;
  try {
    require.resolve('@agent-relay/sdk');
    driver = require.resolve('@agent-relay/harness-driver');
  } catch {
    throw new Error('Broker agents require optional @agent-relay/harness-driver and @agent-relay/sdk packages (>=12.3.1).');
  }
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const { HarnessDriverClient } = await import(process.argv[1]); const client = HarnessDriverClient.connect({ cwd: process.argv[2] }); try { await client.healthCheck(); } finally { await client.shutdown(); }',
    pathToFileURL(driver).href, cwd], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
  if (probe.status !== 0) {
    throw new Error(`Broker agents require a reachable local Relay broker for ${JSON.stringify(cwd)}. Run agent-relay up in the run root or set AGENT_RELAY_STATE_DIR to its connection directory.`);
  }
}
