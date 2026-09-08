import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { runAgentCli } from '../src/worker-cli.js';

it.each(['claude', 'wrapper.mjs'])('stops %s and its process group when lease ownership is lost', async name => {
  const root = mkdtempSync(join(tmpdir(), 'lease-abort-'));
  const controller = new AbortController();
  const parentPid = join(root, 'parent-pid');
  const childPid = join(root, 'child-pid');
  const effect = join(root, 'late-effect');
  const executable = join(root, name);
  const helper = resolve('../../testdata/preflight/wrapper-session.mjs');
  const childSource = `require('node:fs').writeFileSync(${JSON.stringify(childPid)}, String(process.pid)); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(effect)}, 'unexpected'), 800);`;
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(executable, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
${name === 'wrapper.mjs' ? `import { receiveWrapperRequest } from ${JSON.stringify(helper)}; await receiveWrapperRequest();` : ''}
writeFileSync(${JSON.stringify(parentPid)}, String(process.pid));
spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: 'inherit' });
setInterval(() => {}, 1000);
`);
  chmodSync(executable, 0o755);
  try {
    const running = runAgentCli(executable, 'hello', undefined, undefined, undefined, controller.signal);
    const deadline = Date.now() + 5000;
    while (!existsSync(childPid) && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 10));
    expect(existsSync(childPid)).toBe(true);
    controller.abort(new Error('lease rejected'));
    expect((await running).exit_code).toBeNull();
    await new Promise(resolveWait => setTimeout(resolveWait, 900));
    expect(existsSync(effect)).toBe(false);
    for (const file of [parentPid, childPid]) {
      const pid = Number(readFileSync(file, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
    }
  } finally {
    controller.abort();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
