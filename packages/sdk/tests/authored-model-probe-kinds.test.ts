import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flow } from '@relayflows/surface';
import { afterEach, expect, it } from 'vitest';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { JournalClient } from '../src/journal-client.js';

// An environment refusal from f.agent's preflight used to be recoded as
// `agent_cli_unresolved`, which `flows run` reports as `invalid_spec` — telling
// the author to fix a flow that was never wrong. The kind must survive.
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

// CLAUDE_BIN points this at a real Claude Code binary for end-to-end evidence;
// by default a stand-in replays Claude Code 2.1.278's verbatim refusal.
function project(stdout: string): { cli: string; flowPath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'authored-model-kinds-'));
  directories.push(directory);
  writeFileSync(join(directory, 'flows.json'), JSON.stringify({ models: ['claude-opus-5-5'] }));
  const cli = join(directory, 'claude');
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === 'auth') process.exit(0);
process.stdout.write(${JSON.stringify(stdout)});
process.exit(1);
`);
  chmodSync(cli, 0o755);
  return { cli: process.env['CLAUDE_BIN'] ?? cli, flowPath: join(directory, 'flow.ts') };
}

it.each([
  ['cli_outdated', "API Error: 400 Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required."],
  ['provider_usage_limited', "You've hit your limit · resets 3pm (UTC)"],
] as const)('keeps a %s preflight refusal instead of agent_cli_unresolved', async (kind, stdout) => {
  if (process.env['CLAUDE_BIN'] !== undefined && kind !== 'cli_outdated') return;
  const { cli, flowPath } = project(stdout);
  const journal = new JournalClient('/journal-must-not-be-contacted');
  await expect(executeAuthoredFlow(flow('model-probe-kinds', async (f) => {
    await f.agent('worker', { task: 'x', cli, model: 'claude-opus-5-5' });
    f.done('success');
  }), journal, undefined, { flowPath })).rejects.toMatchObject({ code: kind });
}, 90_000);
