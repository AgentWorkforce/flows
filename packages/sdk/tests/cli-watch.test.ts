import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, rename, utimes, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { watchChecks } from '../src/cli-watch.js';
import { runCli } from '../src/cli.js';

const sdk = fileURLToPath(new URL('..', import.meta.url));
const fixtureSource = await readFile(resolve(sdk, '../../testdata/hello-deterministic.flow.yaml'), 'utf8');
const directories: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
let bin: string;
beforeAll(async () => {
  bin = await mkdtemp(join(tmpdir(), 'flows-watch-bin-'));
  await symlink(join(sdk, 'dist/cli.js'), join(bin, 'flows'));
});
afterAll(async () => { await rm(bin, { recursive: true, force: true }); });

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGINT');
      await closed;
    }
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function project(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'flows-watch-'));
  directories.push(directory);
  await writeFile(join(directory, 'flows.json'), '{}');
  const path = join(directory, 'fixture.yaml');
  await writeFile(path, fixtureSource);
  return { directory, path };
}

function start(path: string, json = false) {
  // The package's flows binary is produced by the ordinary SDK build.
  const child = spawn(process.env['BUN_BIN'] ?? 'bun', ['run', 'flows', 'check', '--watch', ...(json ? ['--json'] : []), path], {
    cwd: sdk,
    env: { ...process.env, PATH: `${bin}:${process.env['PATH']}` },
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const reports = () => stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  return { child, stdout: () => stdout, stderr: () => stderr, reports };
}

async function until(predicate: () => boolean): Promise<void> {
  await expect.poll(predicate, { timeout: 5000, interval: 20 }).toBe(true);
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  const closed = once(child, 'close');
  child.kill('SIGINT');
  return (await closed)[0] as number | null;
}

async function touch(path: string): Promise<void> {
  const now = new Date();
  await utimes(path, now, now);
}

describe('flows check --watch', () => {
  it('rechecks syntax errors, clears once, and returns the last refusal on Ctrl-C', async () => {
    const { path } = await project();
    const output = start(path);
    await until(() => output.stdout().includes('CHECK PASSED'));
    await writeFile(path, 'steps: [');
    await until(() => output.stderr().includes('contains invalid YAML or JSON'));
    expect(output.stdout().match(/\x1b\[2J\x1b\[H/g)).toHaveLength(1);
    expect(await stop(output.child)).toBe(2);
  });

  it('streams JSON lines without ANSI, recovers after atomic saves, and exits zero after repair', async () => {
    const { path } = await project();
    const output = start(path, true);
    await until(() => output.reports().length === 1);
    await writeFile(`${path}.new`, 'steps: [');
    await rename(`${path}.new`, path);
    await until(() => output.reports().length === 2);
    await writeFile(path, fixtureSource);
    await until(() => output.reports().length === 3);
    expect(output.reports().map((report) => report.ok)).toEqual([true, false, true]);
    expect(output.stdout()).not.toContain('\x1b');
    expect(output.stdout().trim().split('\n')).toHaveLength(3);
    expect(await stop(output.child)).toBe(0);
  });

  it('coalesces 20 concurrent saves into at most two rechecks', async () => {
    const { path } = await project();
    const output = start(path, true);
    await until(() => output.reports().length === 1);
    await Promise.all(Array.from({ length: 20 }, () => writeFile(path, fixtureSource)));
    await until(() => output.reports().length >= 2);
    await delay(500);
    expect(output.reports().length).toBeLessThanOrEqual(3);
  });

  it('watches transitive relative use imports, cycles, and nearest config changes', async () => {
    const { directory, path } = await project();
    await writeFile(path, `${fixtureSource}\nuse: ['./reviewer.flow.ts', './middle.yaml']\n`);
    const reviewer = join(directory, 'reviewer.flow.ts');
    const nested = join(directory, 'nested.yaml');
    await writeFile(reviewer, "export default {};\n");
    await writeFile(join(directory, 'middle.yaml'), "use: ['./nested.yaml']\n");
    await writeFile(nested, "use: ['./fixture.yaml']\n");
    const output = start(path, true);
    await until(() => output.reports().length === 1);
    // Watching a dependency does not change this base's unsupported-use refusal.
    expect(output.reports()[0].diagnostics[0].message).toContain('unknown key \"use\"');
    await touch(reviewer);
    await until(() => output.reports().length === 2);
    await touch(nested);
    await until(() => output.reports().length === 3);
    await touch(join(directory, 'flows.json'));
    await until(() => output.reports().length === 4);
  });

  it('refreshes the import graph and notices missing imports being created', async () => {
    const { directory, path } = await project();
    const output = start(path, true);
    await until(() => output.reports().length === 1);
    await writeFile(path, `${fixtureSource}\nuse: ['./new/reviewer.yaml']\n`);
    await until(() => output.reports().length === 2);
    await mkdir(join(directory, 'new'));
    await writeFile(join(directory, 'new/reviewer.yaml'), '{}');
    await until(() => output.reports().length === 3);
    await touch(join(directory, 'new/reviewer.yaml'));
    await until(() => output.reports().length === 4);
  });

  it('reloads authored TypeScript instead of reusing the first imported definition', async () => {
    const { directory } = await project();
    await symlink(join(sdk, 'node_modules'), join(directory, 'node_modules'), 'dir');
    const path = join(directory, 'authored.flow.ts');
    const source = `import { flow } from '@relayflows/surface';
export default flow('watch', {}, async (f) => f.done('success'));`;
    await writeFile(path, source);
    const output = start(path, true);
    await until(() => output.reports().length === 1);
    expect(output.reports()[0].ok).toBe(true);
    await writeFile(path, source.replace("'watch', {}", "'watch', { identitty: 'typo' }"));
    await until(() => output.reports().length === 2);
    expect(output.reports()[1].ok).toBe(false);
    expect(output.reports()[1].diagnostics[0].message).toContain('unsupported_header');
  });

  it('detects a nearer config appearing and falls back after it is deleted', async () => {
    const { directory } = await project();
    const nested = join(directory, 'sub');
    await mkdir(nested);
    const path = join(nested, 'fixture.yaml');
    await writeFile(path, fixtureSource);
    const output = start(path, true);
    await until(() => output.reports().length === 1);
    expect(output.reports()[0].projectConfigPath).toBe(join(directory, 'flows.json'));
    await writeFile(join(nested, 'flows.json'), '{}');
    await until(() => output.reports().length === 2);
    expect(output.reports()[1].projectConfigPath).toBe(join(nested, 'flows.json'));
    await rm(join(nested, 'flows.json'));
    await until(() => output.reports().length === 3);
    expect(output.reports()[2].projectConfigPath).toBe(join(directory, 'flows.json'));
  });

  it('keeps watching after the target is deleted and recreated', async () => {
    const { path } = await project();
    const output = start(path, true);
    await until(() => output.reports().length === 1);
    await rm(path);
    await until(() => output.reports().length === 2);
    expect(output.reports()[1].diagnostics[0].kind).toBe('input_unreadable');
    await writeFile(path, fixtureSource);
    await until(() => output.reports().length === 3);
    expect(output.reports()[2].ok).toBe(true);
  });

  it('queues changes during a slow check without overlapping checks', async () => {
    const { path } = await project();
    const controller = new AbortController();
    let checks = 0;
    let active = 0;
    let maxActive = 0;
    const watching = watchChecks({ path, signal: controller.signal, clear: () => {}, check: async () => {
      checks++;
      maxActive = Math.max(maxActive, ++active);
      await delay(350);
      active--;
      return 0;
    } });
    try {
      await until(() => checks === 1);
      await touch(path);
      await until(() => checks === 2);
      await delay(400);
      expect(checks).toBe(2);
      expect(maxActive).toBe(1);
    } finally { controller.abort(); await watching; }
  });

  it('rejects duplicate watch flags and watch on other verbs', async () => {
    for (const args of [['check', '--watch', '--watch', 'x.yaml'], ['run', '--watch', 'x.yaml'], ['resume', '--watch', 'id']]) {
      expect(await runCli(args, { stdout: () => {}, stderr: () => {} })).toBe(2);
    }
  });
});
