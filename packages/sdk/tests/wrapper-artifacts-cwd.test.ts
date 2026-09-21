import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgentCli } from '../src/worker-cli.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/**
 * A real wrapper CLI (no mocks) that writes `review/here.md` relative to its
 * own cwd, plus whatever extra files `alsoWrites` names — used to stand in for
 * writes that happen inside the snapshot interval but are not the agent's.
 */
function wrapper(root: string, alsoWrites: string[] = []): string {
  const path = join(root, 'agent.mjs');
  writeFileSync(path, `#!/usr/bin/env node
import { receiveWrapperRequest } from ${JSON.stringify(resolve('../../testdata/preflight/wrapper-session.mjs'))};
import { mkdirSync, writeFileSync } from 'node:fs';
if (process.argv[2] === 'auth') process.exit(0);
const request = await receiveWrapperRequest();
if (request) {
  mkdirSync('review', { recursive: true }); writeFileSync('review/here.md', 'x');
  for (const extra of ${JSON.stringify(alsoWrites)}) {
    mkdirSync(extra.split('/').slice(0, -1).join('/') || '.', { recursive: true });
    writeFileSync(extra, 'not the agent\\n');
  }
  console.log('ok'); process.exit(0);
}
`);
  chmodSync(path, 0o755);
  return path;
}

describe('wrapper artifacts follow the requested cwd', () => {
  it('spawns the wrapper in `cwd` and measures artifacts there, not in the worker process directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wrapper-cwd-'));
    dirs.push(root);
    const cli = wrapper(root);
    const agentDir = join(root, 'elsewhere');
    mkdirSync(agentDir);
    const result = await runAgentCli(cli, 'write', undefined, undefined, undefined, undefined, 'agent', undefined, agentDir);
    expect(result.exit_code, result.stderr_tail).toBe(0);
    expect(result.artifacts).toEqual(['review/here.md']);
    // The file is where the agent ran, not where this test process runs.
    expect(() => rmSync(join(agentDir, 'review/here.md'))).not.toThrow();
  });

  it('never reports the kernel data dir, even when the daemon writes there while the agent runs', async () => {
    // A local `--data-dir` inside the project (the Cloud executor's shape)
    // puts the run journals inside the scanned tree. The daemon appends to
    // them on its own schedule — the authored step index is written to the
    // ROOT run's journal the moment a child is admitted, which is while this
    // agent is running — and in a content diff that is indistinguishable from
    // a file the agent wrote. It was reported as one, and an `artifact_exists`
    // gate read the kernel's own state as the agent's work.
    const root = mkdtempSync(join(tmpdir(), 'wrapper-datadir-'));
    dirs.push(root);
    const agentDir = join(root, 'project');
    mkdirSync(agentDir);
    const dataDir = join(agentDir, 'data');
    // Pre-existing and changed during the interval, plus created during it:
    // a diff reports both, so both have to be excluded.
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    writeFileSync(join(dataDir, 'runs', 'root.sqlite3'), 'before\n');
    const result = await runAgentCli(
      wrapper(root, ['data/runs/root.sqlite3', 'data/runs/child.sqlite3']),
      'write', undefined, 'unpriced-test-model', undefined, undefined, 'agent',
      { dataDir, runId: 'run-1', stepId: 'agent-1', attempt: 1, onDrive() {} }, agentDir,
    );

    expect(result.exit_code, result.stderr_tail).toBe(0);
    expect(result.artifacts).toEqual(['review/here.md']);
  });
});
