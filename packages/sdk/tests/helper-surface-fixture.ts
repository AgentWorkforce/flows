import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { runCli } from '../src/cli.js';

/** Shared staging for the helper-surface check suites. */
export const directories: string[] = [];
/** Register the env isolation and temp cleanup every helper-surface suite needs. */
export function useHelperSurfaceEnv(): void {
  beforeEach(() => {
    for (const key of ['SLACK_BOT_TOKEN', 'RELAYFLOWS_SLACK_MOCK', 'RELAYFLOWS_LINEAR_MOCK',
      'RELAYFLOWS_NOTION_MOCK', 'RELAYFILE_MOUNT_PATH', 'WORKSPACE_ROOT',
      'WORKFORCE_SANDBOX_ROOT', 'RELAYFILE_MOUNT_ROOT', 'RELAYFILE_ROOT']) vi.stubEnv(key, '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
}
export function fixture(body = "await f.slack.post('#test', 'hi');", header = '', name = 'test.flow.ts') {
  const dir = mkdtempSync(join(tmpdir(), 'helper-surface-'));
  directories.push(dir);
  writeFileSync(join(dir, 'flows.json'), '{}');
  mkdirSync(join(dir, 'node_modules/@relayflows'), { recursive: true });
  symlinkSync(resolve('node_modules/@relayflows/surface'), join(dir, 'node_modules/@relayflows/surface'));
  const path = join(dir, name);
  writeFileSync(path, `import { flow } from '@relayflows/surface';
export default flow('test', ${header} async f => { ${body} f.done('success'); });`);
  return path;
}
/**
 * A shipped example, copied where `@relayflows/surface` resolves — the same
 * staging `tests/flow-requirements.test.ts` uses. Copied rather than checked in
 * place because `examples/` carries no `package.json`, so a checkout whose
 * ancestry declares `"type": "commonjs"` cannot import an authored `.flow.ts`
 * there at all; the temp copy declares its own module boundary.
 */
export function shippedExample(name: string) {
  const dir = mkdtempSync(join(tmpdir(), 'helper-surface-example-'));
  directories.push(dir);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'flows.json'), '{}');
  mkdirSync(join(dir, 'node_modules/@relayflows'), { recursive: true });
  symlinkSync(resolve('node_modules/@relayflows/surface'), join(dir, 'node_modules/@relayflows/surface'));
  const path = join(dir, `${name}.flow.ts`);
  copyFileSync(resolve('../../examples', name, `${name}.flow.ts`), path);
  return path;
}
export async function check(path: string, json = false, verb = 'check') {
  const lines: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = await runCli([verb, ...(json ? ['--json'] : []), path, ...(verb === 'run' && path.endsWith('.flow.ts') ? ['--input', '{}'] : [])], {
    stdout: line => { stdout.push(line); lines.push(line); },
    stderr: line => { stderr.push(line); lines.push(line); },
  });
  return { exit, lines, stdout, stderr };
}
