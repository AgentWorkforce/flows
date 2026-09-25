import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JournalClient } from '../src/journal-client.js';
import { socketPathFor } from '../src/daemon-connection.js';

/**
 * flows#357, end to end, through the argv the ticket used: `flows run --json
 * --local-agent <flow.ts>` against a real daemon, with agents driving two
 * checkouts under one run root.
 *
 * The bug was a split: the SDK accepted `cwd`, lowered it, and the kernel
 * refused the run with `invalid_spec: unknown field "cwd" at steps[0]`. Only a
 * live run proves the halves agree, because only a live run puts a real spec
 * in front of a real kernel — the unit tests either side of the boundary both
 * passed while the boundary was broken.
 *
 * So what is asserted here is where the CLI actually ran, read back from the
 * journal and from the disk, and that a declaration this contract cannot
 * honour is refused at the edge it belongs to.
 */

const roots: string[] = [];
const sdk = resolve('.');
const cli = process.env['FLOWS_TEST_CLI'] ?? join(sdk, 'dist/cli.js');
const wrapperHelper = resolve('../../testdata/preflight/wrapper-session.mjs');

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

/**
 * A run root holding two checkouts. The wrapper CLI writes `<name>` from its
 * instruction into its own working directory and reports that directory, so
 * the step's output says where it ran rather than where it was asked to run.
 */
function fixture(body: string) {
  const relayflowd = resolveDaemon();
  const root = mkdtempSync(join(tmpdir(), 'flows-cwd-live-'));
  roots.push(root);
  symlinkSync(join(sdk, 'node_modules'), join(root, 'node_modules'));
  mkdirSync(join(root, 'checkouts', 'service-a'), { recursive: true });
  mkdirSync(join(root, 'checkouts', 'service-b'), { recursive: true });
  const wrapper = join(root, 'agent.mjs');
  writeFileSync(wrapper, `#!/usr/bin/env node
import { receiveWrapperRequest } from ${JSON.stringify(wrapperHelper)};
import { writeFileSync } from 'node:fs';
if (process.argv[2] === 'auth') process.exit(0);
const request = await receiveWrapperRequest();
if (request) {
  const name = (request.instruction.match(/write:(\\S+)/) ?? [])[1];
  if (name) writeFileSync(name, 'written by ' + name + '\\n');
  console.log('ran in ' + process.cwd());
  process.exit(0);
}
`);
  chmodSync(wrapper, 0o755);
  writeFileSync(join(root, 'flows.json'), JSON.stringify({ cli: wrapper }));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'edit.flow.ts'),
    `import { flow } from '@relayflows/surface';\nexport default flow('edit', async f => {\n${body}\n});\n`);
  return {
    root,
    invoke: () => spawnSync(process.execPath,
      [cli, 'run', '--json', '--data-dir', join(root, 'data'), '--local-agent', 'edit.flow.ts', '--input', '{}'],
      { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, RELAYFLOWD_BIN: relayflowd } }),
  };
}

interface Entry { entry_type: string; step_id?: string; payload: { completionReason?: string; output?: unknown } }

/** Every `step.completed` across the child runs the root run lists, by step id. */
async function readJournal(root: string, rootRunId: string, extraRunIds: string[] = []) {
  const client = new JournalClient(socketPathFor(join(root, 'data')), { requestTimeoutMs: 5000 });
  await client.connect();
  await client.hello('agent-cwd-live-test');
  try {
    const rootEntries = (await client.journalRead(rootRunId, 1, 1000)).entries as Entry[];
    const rootDone = rootEntries.find(e => e.entry_type === 'step.completed' && e.step_id === 'authored-root');
    const journalSteps = (rootDone?.payload.output as { journalSteps?: Array<{ id: string; runId: string }> } | undefined)?.journalSteps ?? [];
    const completed = new Map<string, Entry>();
    for (const runId of [...journalSteps.map(step => step.runId), ...extraRunIds]) {
      const entries = (await client.journalRead(runId, 1, 1000)).entries as Entry[];
      for (const entry of entries) {
        if (entry.entry_type === 'step.completed' && entry.step_id !== undefined) completed.set(entry.step_id, entry);
      }
    }
    return completed;
  } finally {
    client.close();
  }
}

function reportedRunIds(report: { runId?: string; diagnostics?: Array<{ message: string }> }): string[] {
  const ids = new Set<string>();
  if (report.runId) ids.add(report.runId);
  for (const d of report.diagnostics ?? []) {
    for (const m of d.message.matchAll(/\b(01[0-9A-HJKMNP-TV-Z]{24})\b/g)) ids.add(m[1]!);
  }
  return [...ids];
}

type Output = { stdout_tail?: string; artifacts?: string[] };

describe('agents drive two checkouts under one run root', () => {
  it('runs each CLI in its declared directory, and the run is not refused as an unknown field', async () => {
    const f = fixture(`
  const a = await f.agent('edit-a', { task: 'edit write:a.txt', cwd: 'checkouts/service-a' });
  const b = await f.agent('edit-b', { task: 'edit write:b.txt', cwd: 'checkouts/service-b' });
  const root = await f.agent('note-root', { task: 'edit write:root.txt' });
  if (!a.artifacts.includes('a.txt')) throw new Error('a artifacts: ' + JSON.stringify(a.artifacts));
  if (!b.artifacts.includes('b.txt')) throw new Error('b artifacts: ' + JSON.stringify(b.artifacts));
  if (!root.artifacts.includes('root.txt')) throw new Error('root artifacts: ' + JSON.stringify(root.artifacts));
  f.done('success');`);
    const result = f.invoke();
    // The ticket's symptom, pinned by its own words: the run reached the
    // kernel and was accepted, rather than coming back a protocol error.
    expect(result.stdout + result.stderr).not.toContain('unknown field "cwd"');
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const report = JSON.parse(result.stdout) as { runId: string; completionReason: string };
    expect(report.completionReason).toBe('success');

    const completed = await readJournal(f.root, report.runId);
    // Where each CLI actually ran, as the process itself reported it.
    expect((completed.get('agent-1')!.payload.output as Output).stdout_tail)
      .toContain(join(f.root, 'checkouts', 'service-a'));
    expect((completed.get('agent-2')!.payload.output as Output).stdout_tail)
      .toContain(join(f.root, 'checkouts', 'service-b'));

    // Artifacts are measured in the directory the agent ran in, so the paths a
    // gate names are relative to THAT directory and not to the run root.
    expect((completed.get('agent-1')!.payload.output as Output).artifacts).toEqual(['a.txt']);
    expect((completed.get('agent-2')!.payload.output as Output).artifacts).toEqual(['b.txt']);

    // And the files landed only under the checkout that asked for them.
    expect(existsSync(join(f.root, 'checkouts', 'service-a', 'a.txt'))).toBe(true);
    expect(existsSync(join(f.root, 'checkouts', 'service-b', 'b.txt'))).toBe(true);
    expect(existsSync(join(f.root, 'checkouts', 'service-a', 'b.txt'))).toBe(false);
    expect(existsSync(join(f.root, 'checkouts', 'service-b', 'a.txt'))).toBe(false);
    // A step that declares nothing still runs in the run root.
    expect(existsSync(join(f.root, 'root.txt'))).toBe(true);
  }, 120_000);

  it('gates on an artifact path relative to the agent directory', async () => {
    const f = fixture(`
  await f.agent('edit-a', { task: 'edit write:a.txt', cwd: 'checkouts/service-a' })
    .gate({ type: 'artifact_exists', path: 'a.txt' });
  f.done('success');`);
    const result = f.invoke();
    expect(result.status, result.stderr + result.stdout).toBe(0);
  }, 120_000);
});

describe('a declaration this contract cannot honour is refused at its own edge', () => {
  it('refuses a path that climbs out of the run root without starting a run at all', async () => {
    const f = fixture(`
  await f.agent('escape', { task: 'edit write:a.txt', cwd: '../elsewhere' });
  f.done('success');`);
    const result = f.invoke();
    const said = result.stdout + result.stderr;
    expect(result.status, said).not.toBe(0);
    const report = JSON.parse(result.stdout) as { runId?: string; diagnostics: Array<{ message: string }> };
    // The refusal is the SDK's own, in its own words, about the author's own
    // option — not the kernel's `unknown field "cwd"` relayed back afterwards.
    expect(report.diagnostics.map(d => d.message).join('\n'))
      .toContain('f.agent options.cwd: expected a run-root-relative path');
    expect(said).not.toContain('unknown field "cwd"');
    // And no run exists to inspect: the declaration was refused before one was
    // started, which is the half of the ticket that `flows check` also covers.
    expect(report.runId).toBeUndefined();
  }, 120_000);

  it('fails the step with the reason when the directory is not there, rather than running somewhere else', async () => {
    const f = fixture(`
  await f.agent('missing', { task: 'edit write:a.txt', cwd: 'checkouts/service-c' });
  f.done('success');`);
    const result = f.invoke();
    expect(result.status, result.stderr + result.stdout).toBe(1);
    const report = JSON.parse(result.stdout) as {
      runId: string; diagnostics: Array<{ kind: string; stderrTail?: string }>;
    };
    // The kernel accepted the spec and dispatched it; the worker — the process
    // that shares the agent's filesystem — is what refused, and said why.
    const failure = report.diagnostics.find(d => d.kind === 'step_failed');
    expect(failure?.stderrTail).toContain('agent step "agent-1": cwd "checkouts/service-c"');
    expect(failure?.stderrTail).toContain('no such directory under the run root');

    // On a `worker_error` the kernel nulls `output` and keeps the wrapper as
    // the execution gate's detail, so that is where the reason is journaled.
    const completed = await readJournal(f.root, report.runId, reportedRunIds(report));
    const payload = completed.get('agent-1')!.payload as { verification?: { detail?: string; verdict?: string } };
    expect(payload.verification?.verdict).toBe('fail');
    expect(payload.verification?.detail).toContain('no such directory under the run root');

    // Nothing was invented to make the declaration true, and the agent did not
    // quietly fall back to the run root.
    expect(existsSync(join(f.root, 'checkouts', 'service-c'))).toBe(false);
    expect(existsSync(join(f.root, 'a.txt'))).toBe(false);
  }, 120_000);
});
