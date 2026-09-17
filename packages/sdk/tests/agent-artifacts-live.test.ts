import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JournalClient } from '../src/journal-client.js';
import { socketPathFor } from '../src/daemon-connection.js';

/**
 * The Cloud path, end to end: the built CLI is invoked with the exact argv
 * Cloud's relayflow-v2-executor builds (`run --json --data-dir … --local-agent
 * <flow.ts> --input …`), against a real daemon, with a wrapper CLI that
 * actually writes files into its cwd. What is asserted is read back from the
 * journal, because that is what a gate, a resume and a replay read.
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

/** A wrapper CLI that writes `review/<lens>.md` for each lens named in its instruction. */
function fixture(body: string) {
  const relayflowd = resolveDaemon();
  const root = mkdtempSync(join(tmpdir(), 'flows-artifacts-live-'));
  roots.push(root);
  symlinkSync(join(sdk, 'node_modules'), join(root, 'node_modules'));
  const wrapper = join(root, 'agent.mjs');
  writeFileSync(wrapper, `#!/usr/bin/env node
import { receiveWrapperRequest } from ${JSON.stringify(wrapperHelper)};
import { mkdirSync, writeFileSync } from 'node:fs';
if (process.argv[2] === 'auth') process.exit(0);
const request = await receiveWrapperRequest();
if (request) {
  for (const lens of request.instruction.match(/write:(\\S+)/g) ?? []) {
    const path = lens.slice('write:'.length);
    mkdirSync(path.split('/').slice(0, -1).join('/') || '.', { recursive: true });
    writeFileSync(path, 'findings for ' + path + '\\n');
  }
  console.log('reviewed');
  process.exit(0);
}
`);
  chmodSync(wrapper, 0o755);
  writeFileSync(join(root, 'flows.json'), JSON.stringify({ cli: wrapper }));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'review.flow.ts'), `import { flow } from '@relayflows/surface';\nexport default flow('review', async f => {\n${body}\n});\n`);
  return {
    root,
    invoke: () => spawnSync(process.execPath,
      [cli, 'run', '--json', '--data-dir', join(root, 'data'), '--local-agent', 'review.flow.ts', '--input', '{}'],
      { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, RELAYFLOWD_BIN: relayflowd } }),
  };
}

interface Entry { entry_type: string; step_id?: string; payload: { completionReason?: string; output?: unknown } }

/**
 * Every `step.completed` across the runs named in `runIds`, keyed by step id.
 * A successful root lists its child runs in `journalSteps`; a failed root does
 * not, so callers hand over the run ids the report named.
 */
async function readJournal(root: string, rootRunId: string, extraRunIds: string[] = []) {
  const client = new JournalClient(socketPathFor(join(root, 'data')), { requestTimeoutMs: 5000 });
  await client.connect();
  await client.hello('artifacts-live-test');
  try {
    const rootEntries = (await client.journalRead(rootRunId, 1, 1000)).entries as Entry[];
    const rootDone = rootEntries.find(e => e.entry_type === 'step.completed' && e.step_id === 'authored-root');
    const journalSteps = (rootDone?.payload.output as { journalSteps?: Array<{ id: string; runId: string; completionReason: string }> } | undefined)?.journalSteps ?? [];
    const completed = new Map<string, Entry>();
    for (const runId of [...journalSteps.map(step => step.runId), ...extraRunIds]) {
      const entries = (await client.journalRead(runId, 1, 1000)).entries as Entry[];
      for (const entry of entries) {
        if (entry.entry_type === 'step.completed' && entry.step_id !== undefined) completed.set(entry.step_id, entry);
      }
    }
    return { journalSteps, completed };
  } finally {
    client.close();
  }
}

/** Run ids a failure report names: the failing step's own run, and any it quotes. */
function reportedRunIds(report: { runId?: string; diagnostics: Array<{ message: string }> }): string[] {
  const ids = new Set<string>();
  if (report.runId) ids.add(report.runId);
  for (const d of report.diagnostics) for (const m of d.message.matchAll(/\b(01[0-9A-HJKMNP-TV-Z]{24})\b/g)) ids.add(m[1]!);
  return [...ids];
}

describe('agent artifacts and gates through the built CLI, a real daemon and the local agent', () => {
  it('journals the files the agent wrote, and both artifact gates pass on that journal', async () => {
    const f = fixture(`
  const security = await f.agent('security-reviewer', { task: 'review write:review/security.md' })
    .gate({ type: 'artifact_exists', path: 'review/security.md' });
  const correctness = await f.agent('correctness-reviewer', { task: 'review write:review/correctness.md' })
    .gate(r => r.artifacts.includes('review/correctness.md'), 'the reviewer must write its findings');
  const both = await f.run('ls review');
  if (!security.artifacts.includes('review/security.md')) throw new Error('security artifacts missing');
  if (!correctness.artifacts.includes('review/correctness.md')) throw new Error('correctness artifacts missing');
  if (!both.includes('security.md') || !both.includes('correctness.md')) throw new Error('files not on disk');
  f.done('success');`);
    const result = f.invoke();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const report = JSON.parse(result.stdout) as { runId: string; completionReason: string };
    expect(report.completionReason).toBe('success');

    const { journalSteps, completed } = await readJournal(f.root, report.runId);
    // The named gate is lowered INTO the agent's own kernel run (`agent-1` +
    // `agent-1.gate` in one spec); the predicate gate is its own lowered run;
    // then the ls and the terminal marker. Every one is a journaled kernel step.
    expect(journalSteps.map(s => s.id)).toEqual(['agent-1', 'agent-2', 'agent-2.gate', 'run-3', 'complete-4']);
    expect(completed.has('agent-1.gate')).toBe(true);

    // The worker journaled the artifacts in the step output — the fact the gates read.
    const agent1 = completed.get('agent-1')!.payload.output as { artifacts?: string[]; stdout_tail?: string };
    expect(agent1.artifacts).toEqual(['review/security.md']);
    expect(agent1.stdout_tail).toContain('reviewed');
    expect((completed.get('agent-2')!.payload.output as { artifacts?: string[] }).artifacts).toEqual(['review/correctness.md']);

    // Named gate: a deterministic step reading FLOWS_INPUT, passed.
    expect(completed.get('agent-1.gate')!.payload.completionReason).toBe('success');
    // Predicate gate: the recorded verdict, with the author's reason.
    const predicate = completed.get('agent-2.gate')!.payload;
    expect(predicate.completionReason).toBe('success');
    expect((predicate.output as { stdout_tail: string }).stdout_tail)
      .toBe(JSON.stringify({ gate: 'predicate', step: 'agent-2', verdict: 'pass', because: 'the reviewer must write its findings' }));
  }, 120_000);

  it('fails the run when the artifact_exists gate names a file the agent did not write', async () => {
    const f = fixture(`
  await f.agent('lazy-reviewer', { task: 'review write:review/security.md' })
    .gate({ type: 'artifact_exists', path: 'review/performance.md' });
  f.done('success');`);
    const result = f.invoke();
    expect(result.status, result.stderr + result.stdout).toBe(1);
    const report = JSON.parse(result.stdout) as { runId: string; diagnostics: Array<{ kind: string; message: string }> };
    expect(report.diagnostics.map(d => d.kind)).toContain('step_failed');
    expect(JSON.stringify(report.diagnostics)).toContain('agent-1.gate');
    // The report's run id is the failing step's own kernel run: the agent step
    // completed there with its artifacts journaled, and the gate step failed.
    const { completed } = await readJournal(f.root, report.runId, reportedRunIds(report));
    expect((completed.get('agent-1')!.payload.output as { artifacts?: string[] }).artifacts).toEqual(['review/security.md']);
    expect(completed.get('agent-1.gate')!.payload.completionReason).not.toBe('success');
  }, 120_000);

  it('fails the run with the author reason when a predicate gate returns false, journaling the verdict', async () => {
    const f = fixture(`
  await f.agent('quiet-reviewer', { task: 'review write:review/security.md' })
    .gate(r => r.artifacts.includes('review/consensus.md'), 'consensus must be written');
  f.done('success');`);
    const result = f.invoke();
    expect(result.status, result.stderr + result.stdout).toBe(1);
    const report = JSON.parse(result.stdout) as { runId: string; diagnostics: Array<{ kind: string; message: string }> };
    const messages = report.diagnostics.map(d => `${d.kind}: ${d.message}`).join('\n');
    expect(messages).toContain('gate_failed');
    expect(messages).toContain('consensus must be written');
    const { completed } = await readJournal(f.root, report.runId, reportedRunIds(report));
    const verdict = completed.get('agent-1.gate')!.payload;
    expect(verdict.completionReason).not.toBe('success');
    expect((verdict.output as { stderr_tail: string }).stderr_tail)
      .toContain('"verdict":"fail"');
  }, 120_000);
});
