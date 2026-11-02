import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runAgentCli } from '../src/worker-cli.js';

// Match the pinned Cloud sandbox release; opt in with a CLI-login token.
const DEVIN_VERSION = '3000.11.234';
const cli = process.env.RELAYFLOWS_REAL_DEVIN_CLI;
it.runIf(cli !== undefined)('runs the pinned Devin CLI through the real agent worker', async () => {
  const version = spawnSync(cli!, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  expect(version.status).toBe(0);
  expect(version.stdout).toMatch(new RegExp(`^devin ${DEVIN_VERSION.replaceAll('.', '\\.')} `));
  expect(process.env.DEVIN_API_KEY?.length).toBeGreaterThan(0);
  const cwd = mkdtempSync(join(tmpdir(), 'real-devin-'));
  try {
    const result = await runAgentCli(cli!,
      'Reply with exactly RELAYFLOWS_DEVIN_WORKER_READY and nothing else. Do not call tools.',
      undefined, undefined, undefined, undefined, 'agent', undefined, cwd, 'direct', undefined,
      { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        DEVIN_API_KEY: process.env.DEVIN_API_KEY }, 'devin', 60_000);
    expect(result.exit_code).toBe(0);
    expect(result.stdout_tail.trim()).toBe('RELAYFLOWS_DEVIN_WORKER_READY');
    expect(result.tokens_input).toBeUndefined();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}, 70_000);
