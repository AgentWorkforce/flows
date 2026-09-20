import { accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { FlowSpec, KernelRunSpec } from '../spec.js';
import { communicationInstruction } from './spec.js';

const require = createRequire(import.meta.url);
export class CommunicationEnvironmentError extends Error {}

/** Local-only probes: no broker, workspace creation, or optional runtime import in this process. */
export function checkCommunicationEnvironment(spec: FlowSpec | KernelRunSpec): void {
  if (!spec.steps.some(step => step.type === 'agent' && communicationInstruction(step.instruction))) return;
  if (!process.env.RELAY_API_KEY?.trim().startsWith('rk_live_')) {
    throw new CommunicationEnvironmentError('Agent communication requires RELAY_API_KEY for an existing workspace.');
  }
  let driverPath: string;
  try {
    require.resolve('@agent-relay/sdk');
    require.resolve('@agent-relay/harness-driver');
    driverPath = require.resolve('@agent-relay/harness-driver/broker-path');
  } catch {
    throw new CommunicationEnvironmentError('Agent communication requires optional @agent-relay/harness-driver and @agent-relay/sdk packages (>=12.3.1).');
  }
  const probe = spawnSync('node', ['--input-type=module', '-e',
    'const {getBrokerBinaryPath} = await import(process.argv[1]); const path = process.env.RELAYFLOW_RELAY_BROKER_BIN || getBrokerBinaryPath(); if (!path) process.exit(1); process.stdout.write(path);',
    pathToFileURL(driverPath).href], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
  try {
    if (probe.status !== 0 || !probe.stdout.trim()) throw new Error();
    accessSync(probe.stdout.trim(), constants.X_OK);
  } catch {
    throw new CommunicationEnvironmentError('Agent communication requires Node.js and an executable Relay broker; install Agent Relay or set RELAYFLOW_RELAY_BROKER_BIN.');
  }
}
