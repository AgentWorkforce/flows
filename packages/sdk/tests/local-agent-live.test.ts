import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const sdk = resolve('.');
const cli = process.env['FLOWS_TEST_CLI'] ?? join(sdk, 'dist/cli.js');
const wrapperHelper = resolve('../../testdata/preflight/wrapper-session.mjs');
// Ask the existing build wrapper for its target directory. A temp fixture's
// cwd cannot discover the checkout, and test:prep's child-shell exports do not
// survive into vitest. Do not select another worktree's most recent binary.
function resolveDaemon(): string {
  if (process.env['RELAYFLOWD_BIN']) return process.env['RELAYFLOWD_BIN'];
  try {
    return join(JSON.parse(execFileSync('sh', [
      resolve('../../ops/cargo.sh'), 'metadata', '--format-version=1', '--no-deps', '--locked', '--offline',
    ], { cwd: resolve('../../kernel'), encoding: 'utf8',
      env: { ...process.env, RELAYFLOWS_NO_TOOLCHAIN_INSTALL: '1' },
    })).target_directory, 'debug', 'relayflowd');
  } catch (cause) {
    throw new Error('Live CLI tests require npm run test:prep or an explicit RELAYFLOWD_BIN.', { cause });
  }
}
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

function fixture(exitCode = 0, workspace?: string, delayMs = 0) {
  const relayflowd = resolveDaemon();
  const root = mkdtempSync(join(tmpdir(), 'flows-local-agent-'));
  roots.push(root);
  symlinkSync(join(sdk, 'node_modules'), join(root, 'node_modules'));
  const marker = join(root, 'invoked');
  const wrapper = join(root, 'agent.mjs');
  writeFileSync(wrapper, `#!/usr/bin/env node\nimport { receiveWrapperRequest } from ${JSON.stringify(wrapperHelper)};\nimport { appendFileSync } from 'node:fs';\nif (process.argv[2] === 'auth') process.exit(0);\nconst request = await receiveWrapperRequest();\nif (request) { appendFileSync(${JSON.stringify(marker)}, request.instruction); await new Promise(resolve => setTimeout(resolve, ${delayMs})); console.log('local-agent-ok'); process.exit(${exitCode}); }\n`);
  chmodSync(wrapper, 0o755);
  writeFileSync(join(root, 'flows.json'), JSON.stringify({ cli: wrapper }));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'hello.flow.ts'), `import { flow } from '@relayflows/surface';\nexport default flow('hello', async f => { await f.agent('greeter', ${JSON.stringify({ task: 'hello', ...(workspace ? { workspace } : {}) })}); f.done('success'); });\n`);
  // Bound a stuck fixture process, allowing startup/preflight before the
  // kernel's independently enforced worker lease. UX timing is measured by
  // the separate empty-cache cold-start transcript, not this cleanup ceiling.
  return { root, marker, invoke: (...flags: string[]) => spawnSync(process.execPath,
    [cli, 'run', 'hello.flow.ts', '--input', '{}', '--local-agent', '--data-dir', join(root, 'data'), ...flags],
    { cwd: root, encoding: 'utf8', timeout: 90000, env: { ...process.env, RELAYFLOWD_BIN: relayflowd } }) };
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
  it('runs beyond the initial 30-second lease without a second invocation', () => {
    const f = fixture(0, undefined, 35_000);
    const result = f.invoke('--json');
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, completionReason: 'success' });
    expect(readFileSync(f.marker, 'utf8')).toBe('hello');
  }, 90_000);
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
