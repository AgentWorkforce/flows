import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgentCli } from '../src/worker-cli.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A real wrapper CLI (no mocks) that writes `review/here.md` relative to its own cwd. */
function wrapper(root: string): string {
  const path = join(root, 'agent.mjs');
  writeFileSync(path, `#!/usr/bin/env node
import { receiveWrapperRequest } from ${JSON.stringify(resolve('../../testdata/preflight/wrapper-session.mjs'))};
import { mkdirSync, writeFileSync } from 'node:fs';
if (process.argv[2] === 'auth') process.exit(0);
const request = await receiveWrapperRequest();
if (request) { mkdirSync('review', { recursive: true }); writeFileSync('review/here.md', 'x'); console.log('ok'); process.exit(0); }
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
});
