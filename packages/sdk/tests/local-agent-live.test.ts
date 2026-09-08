import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const sdk = resolve('.');
const cli = join(sdk, 'dist/cli.js');
const wrapperHelper = resolve('../../testdata/preflight/wrapper-session.mjs');
afterEach(() => {
  for (const root of roots.splice(0)) {
    const connection = join(root, 'data/connection.json');
    if (existsSync(connection)) {
      const { pid } = JSON.parse(readFileSync(connection, 'utf8'));
      if (typeof pid === 'number') {
        try { process.kill(pid, 'SIGTERM'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(exitCode = 0, workspace?: string) {
  const root = mkdtempSync(join(tmpdir(), 'flows-local-agent-'));
  roots.push(root);
  symlinkSync(join(sdk, 'node_modules'), join(root, 'node_modules'));
  const marker = join(root, 'invoked');
  const wrapper = join(root, 'agent.mjs');
  writeFileSync(wrapper, `#!/usr/bin/env node\nimport { receiveWrapperRequest } from ${JSON.stringify(wrapperHelper)};\nimport { writeFileSync } from 'node:fs';\nif (process.argv[2] === 'auth') process.exit(0);\nconst request = await receiveWrapperRequest();\nif (request) { writeFileSync(${JSON.stringify(marker)}, request.instruction); console.log('local-agent-ok'); process.exit(${exitCode}); }\n`);
  chmodSync(wrapper, 0o755);
  writeFileSync(join(root, 'flows.json'), JSON.stringify({ cli: wrapper }));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'hello.flow.ts'), `import { flow } from '@relayflows/surface';\nexport default flow('hello', async f => { await f.agent('greeter', ${JSON.stringify({ task: 'hello', ...(workspace ? { workspace } : {}) })}); f.done('success'); });\n`);
  return { root, marker, invoke: (...flags: string[]) => spawnSync(process.execPath,
    [cli, 'run', 'hello.flow.ts', '--input', '{}', '--local-agent', '--data-dir', join(root, 'data'), ...flags],
    { cwd: root, encoding: 'utf8', timeout: 30000 }) };
}

describe('built CLI local agent against a real daemon', () => {
  it('dispatches through the wrapper and keeps --json stdout report-shaped', () => {
    const f = fixture();
    const result = f.invoke('--json');
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, status: 'completed', completionReason: 'success' });
    expect(readFileSync(f.marker, 'utf8')).toBe('hello');
    expect(result.stderr).not.toContain('✓');
  });
  it('renders actual agent completion in text output', () => {
    const result = fixture().invoke();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stderr).toContain('✓ agent-1 (agent) [agent: completed]');
  });
  it('returns a failed run when the agent process fails', () => {
    const result = fixture(7).invoke();
    expect(result.status, result.stderr + result.stdout).toBe(1);
    expect(result.stderr).toContain('✗ agent-1');
    expect(result.stderr).not.toContain('[agent: completed]');
  });
  it('refuses a workspace it cannot pin before invoking the agent', () => {
    const f = fixture(0, 'repo');
    const result = f.invoke();
    expect(result.status, result.stderr + result.stdout).toBe(2);
    expect(result.stderr).toContain('stream-only');
    expect(existsSync(f.marker)).toBe(false);
  });
});
