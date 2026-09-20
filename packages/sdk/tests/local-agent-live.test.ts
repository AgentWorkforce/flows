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
  const spawn = (argv: string[]) => spawnSync(process.execPath, [cli, ...argv],
    { cwd: root, encoding: 'utf8', timeout: 90000, env: { ...process.env, RELAYFLOWD_BIN: relayflowd } });
  return {
    root, marker,
    invoke: (...flags: string[]) => spawn(
      ['run', 'hello.flow.ts', '--input', '{}', '--local-agent', '--data-dir', join(root, 'data'), ...flags]),
    /** The same flow, with a caller's `--input` and no worker offered: it parks. */
    park: (input: string, ...flags: string[]) => spawn(
      ['run', 'hello.flow.ts', '--input', input, '--data-dir', join(root, 'data'), ...flags]),
    resume: (runId: string, ...flags: string[]) => spawn(
      ['resume', runId, '--data-dir', join(root, 'data'), ...flags]),
    /** An input document on disk, named by the path this returns. */
    inputFile: (contents: string) => {
      const path = join(root, 'input.json');
      writeFileSync(path, contents);
      return path;
    },
    /**
     * A shell line, run as written. Used to execute a printed remedy verbatim —
     * the only assertion that actually proves "runnable", since it exercises the
     * quoting, the flag order and the argument values all at once.
     */
    shell: (script: string) => spawnSync('sh', ['-c', script],
      { cwd: root, encoding: 'utf8', timeout: 90000, env: { ...process.env, RELAYFLOWD_BIN: relayflowd } }),
  };
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
  /**
   * The headline complaint: an authored `.flow.ts` that parked at an `f.agent`
   * step printed no remedy at all, because the bare `flows run --local-agent
   * <path>` the spec path emitted would have been refused for want of
   * `--input`. It read as "your infrastructure is missing a worker" when the
   * actual fix was one flag away.
   *
   * "Runnable" is asserted by running it: the printed line goes back through a
   * shell verbatim, so the flow path, the `--input` this run was started with
   * and their quoting are all proven at once rather than string-matched.
   */
  it('prints a remedy that runs the parked authored flow to completion', () => {
    const f = fixture();
    // An input with a quote and a space: the two characters that make the
    // difference between a copy-pasteable command and a broken one.
    const input = '{"task":"it\'s a plan","n":1}';

    const parked = f.park(input, '--json', '--no-observer-link');

    expect(parked.status, parked.stderr + parked.stdout).toBe(3);
    expect(JSON.parse(parked.stdout)).toMatchObject({ status: 'parked', parkCause: 'worker_unavailable' });
    const message = JSON.parse(parked.stdout).diagnostics.at(-1).message as string;
    const remedy = /: (flows run [^\n]*?)\. [A-Z]/.exec(message)?.[1];
    expect(remedy, message).toBeDefined();
    expect(remedy).toContain("--local-agent 'hello.flow.ts'");
    expect(existsSync(f.marker)).toBe(false);

    const rerun = f.shell(remedy!.replace(/^flows /,
      `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} `) + ' --json --no-observer-link');

    expect(rerun.status, rerun.stderr + rerun.stdout).toBe(0);
    expect(JSON.parse(rerun.stdout)).toMatchObject({ ok: true, status: 'completed', completionReason: 'success' });
    // The agent really ran. Exit 0 is also what proves the shell delivered the
    // input unmangled: a quote lost in the round trip leaves invalid JSON, and
    // a `.flow.ts` with unparseable `--input` is refused at exit 2.
    expect(readFileSync(f.marker, 'utf8')).toBe('hello');
  }, 90_000);

  /**
   * The same acceptance, one process further on: the run was started from an
   * input FILE, so the resume refusal can only render the recorded input back
   * inline — the journal keeps the document, not the word that carried it.
   *
   * A 300-byte document is ordinary and its inline form is not a legal
   * filename: no path component may exceed 255 bytes, so `parseDirectInput`'s
   * opening `stat` failed ENAMETOOLONG. Read as "could not be inspected", that
   * turned the printed recovery command into an exit-2 `input_unreadable`, and
   * a remedy that cannot be run is the same dead end as no remedy at all.
   */
  it('prints a remedy that runs, for a run started from an input file too long to be one', () => {
    const f = fixture();
    const task = 'x'.repeat(300);
    const inputPath = f.inputFile(JSON.stringify({ task }));

    const parked = f.park(inputPath, '--json', '--no-observer-link');

    expect(parked.status, parked.stderr + parked.stdout).toBe(3);
    const rootRunId = JSON.parse(parked.stdout).rootRunId as string;

    // The obvious recovery, and the one the field report tried: resume the
    // parked root with the flag. An authored root admits its worker at run
    // start, so this is refused — with the new run to start instead.
    const refused = f.resume(rootRunId, '--local-agent', '--json', '--no-observer-link');

    expect(refused.status, refused.stderr + refused.stdout).toBe(2);
    const message = JSON.parse(refused.stdout).diagnostics.at(-1).message as string;
    const remedy = /: (flows run [^\n]*?)\. [A-Z]/.exec(message)?.[1];
    expect(remedy, message).toBeDefined();
    // Inline, because that is all the journal can give back — and longer than
    // any filename, which is the whole of this regression.
    expect(remedy).toContain(`--input '${JSON.stringify({ task })}'`);

    const rerun = f.shell(remedy!.replace(/^flows /,
      `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} `) + ' --json --no-observer-link');

    expect(rerun.status, rerun.stderr + rerun.stdout).toBe(0);
    expect(JSON.parse(rerun.stdout)).toMatchObject({ ok: true, status: 'completed', completionReason: 'success' });
    expect(readFileSync(f.marker, 'utf8')).toBe('hello');
  }, 90_000);

  it('refuses a workspace it cannot pin before invoking the agent', () => {
    const f = fixture(0, 'repo');
    const result = f.invoke();
    expect(result.status, result.stderr + result.stdout).toBe(2);
    expect(result.stderr).toContain('stream-only');
    expect(existsSync(f.marker)).toBe(false);
  });
});
