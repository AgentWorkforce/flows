import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JournalClient } from '../src/journal-client.js';
import { socketFor } from '../src/cli/run.js';

const roots: string[] = [];
const sdk = resolve('.');
const cli = process.env['FLOWS_TEST_CLI'] ?? join(sdk, 'dist/cli.js');

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

function fixture() {
  const relayflowd = resolveDaemon();
  const root = mkdtempSync(join(tmpdir(), 'flows-human-'));
  roots.push(root);
  symlinkSync(join(sdk, 'node_modules'), join(root, 'node_modules'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'ask.flow.ts'), `import { flow } from '@relayflows/surface';
export default flow('ask', async (f, input: { plan: string }) => {
  const summary = await f.run(\`printf '%s' "plan: \${input.plan}"\`);
  const ok = await f.human(\`Ship this?\\n\${summary}\`, { to: 'khaliq' });
  if (!ok) return f.done('declined');
  await f.run("printf '%s' shipped >> effects");
  f.done('success');
});
`);
  const dataDir = join(root, 'data');
  const invoke = (...args: string[]) => spawnSync(process.execPath,
    [cli, ...args, '--data-dir', dataDir, '--json'],
    { cwd: root, encoding: 'utf8', timeout: 90_000, env: { ...process.env, RELAYFLOWD_BIN: relayflowd } });
  return {
    root, dataDir,
    run: () => invoke('run', 'ask.flow.ts', '--input', '{"plan":"v2"}', '--no-observer-link'),
    resume: (runId: string) => invoke('resume', runId, '--no-observer-link'),
    answer: (runId: string, waitId: string, word: string, ...extra: string[]) => invoke('answer', runId, waitId, word, ...extra),
    text: (...args: string[]) => spawnSync(process.execPath, [cli, ...args, '--data-dir', dataDir],
      { cwd: root, encoding: 'utf8', timeout: 90_000, env: { ...process.env, RELAYFLOWD_BIN: relayflowd } }),
  };
}

async function waitEntries(dataDir: string, runId: string) {
  const client = new JournalClient(socketFor(dataDir));
  await client.connect(); await client.hello('human-live-test');
  try {
    const entries = (await client.journalRead(runId, 1, 1000)).entries as Array<{ entry_type: string; step_id?: string; attempt?: number; payload: Record<string, unknown> }>;
    return entries.filter(entry => entry.entry_type.startsWith('wait.') || entry.entry_type === 'step.attempt.started' || entry.entry_type === 'step.completed');
  } finally { client.close(); }
}

describe('f.human against a real daemon', () => {
  it('parks with the question, refuses wrong answers, records one, and resumes to success', async () => {
    const f = fixture();
    const first = f.run();
    expect(first.status, first.stderr + first.stdout).toBe(3);
    const parked = JSON.parse(first.stdout);
    expect(parked).toMatchObject({ ok: false, status: 'parked',
      parkedStep: { id: 'authored-root', type: 'agent' },
      humanWait: { waitId: 'human-2', question: 'Ship this?\nplan: v2', to: 'khaliq' } });
    const runId: string = parked.runId;
    expect(parked.diagnostics.at(-1)).toMatchObject({ severity: 'parked', kind: 'run_parked' });
    expect(parked.diagnostics.at(-1).message).toContain(`flows answer --data-dir ${f.dataDir} ${runId} human-2 yes|no`);

    // The kernel holds the question: a wait.human under the root attempt, no completion.
    const asked = await waitEntries(f.dataDir, runId);
    expect(asked.map(entry => entry.entry_type)).toEqual(['step.attempt.started', 'wait.human']);
    expect(asked[1]!.payload).toMatchObject({ wait_id: 'human-2', prompt: 'Ship this?\nplan: v2', requested_of: 'khaliq', options: ['yes', 'no'] });

    // Resuming before anyone answers reports the same open question.
    const early = f.resume(runId);
    expect(early.status, early.stderr + early.stdout).toBe(3);
    expect(JSON.parse(early.stdout).humanWait).toMatchObject({ waitId: 'human-2' });

    const wrong = f.answer(runId, 'human-1', 'yes');
    expect(wrong.status, wrong.stderr + wrong.stdout).toBe(2);
    expect(JSON.parse(wrong.stdout).diagnostics[0]).toMatchObject({ kind: 'human_wait_unknown' });
    expect(wrong.stderr).toContain('Open: human-2');

    const garbage = f.answer(runId, 'human-2', 'maybe');
    expect(garbage.status).toBe(2);

    const answered = f.answer(runId, 'human-2', 'yes', '--note', 'looks good', '--by', 'khaliq@agent-relay.com');
    expect(answered.status, answered.stderr + answered.stdout).toBe(0);
    expect(JSON.parse(answered.stdout)).toMatchObject({ ok: true, command: 'answer', runId,
      answer: { waitId: 'human-2', answer: true, note: 'looks good' } });
    expect(JSON.parse(answered.stdout).next).toBe(`flows resume --data-dir ${f.dataDir} ${runId}`);

    const twice = f.answer(runId, 'human-2', 'no');
    expect(twice.status, twice.stderr + twice.stdout).toBe(2);
    expect(twice.stderr).toContain('already has an answer to human-2 (yes)');

    const resumed = f.resume(runId);
    expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ ok: true, runId, status: 'completed', completionReason: 'success', completedSteps: 4 });
    expect(readFileSync(join(f.root, 'effects'), 'utf8')).toBe('shipped');

    const closed = await waitEntries(f.dataDir, runId);
    expect(closed.map(entry => `${entry.entry_type}@${entry.attempt}`)).toEqual([
      'step.attempt.started@1', 'wait.human@1', 'wait.completed@1', 'step.attempt.started@2', 'step.completed@2',
    ]);
    expect(closed[2]!.payload).toMatchObject({ wait_id: 'human-2', completionReason: 'human_responded',
      result: { answer: true, note: 'looks good', answeredBy: 'khaliq@agent-relay.com' } });
    expect(closed[4]!.payload).toMatchObject({ completionReason: 'success' });
    // A resume after completion replays nothing and reports the durable result.
    const again = f.resume(runId);
    expect(again.status, again.stderr + again.stdout).toBe(0);
    expect(readFileSync(join(f.root, 'effects'), 'utf8')).toBe('shipped');
  }, 120_000);

  it('a "no" is a value the body branches on: declined, exit 0, no effect', () => {
    const f = fixture();
    const first = f.text('run', 'ask.flow.ts', '--input', '{"plan":"v2"}', '--no-observer-link');
    expect(first.status, first.stderr + first.stdout).toBe(3);
    // The question is rendered as a park, never as a failed step.
    expect(first.stderr).toContain('⏸ human-2 (human)');
    expect(first.stderr).not.toContain('✗');
    expect(first.stderr).toContain('PARKED [run_parked]');
    const runId = /^RUN (\S+) parked$/m.exec(first.stdout)![1]!;
    const answered = f.text('answer', runId, 'human-2', 'no');
    expect(answered.status, answered.stderr + answered.stdout).toBe(0);
    expect(answered.stdout).toContain(`ANSWERED ${runId} human-2 no`);
    expect(answered.stdout).toContain('Continue with: flows resume');
    const resumed = f.resume(runId);
    expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ ok: true, completionReason: 'success',
      diagnostics: [{ kind: 'run_declined' }] });
    expect(existsSync(join(f.root, 'effects'))).toBe(false);
  }, 120_000);

  it('refuses to answer a run the daemon does not know', () => {
    const f = fixture();
    // Start the daemon with a real run first so the refusal is the run, not the socket.
    expect(f.run().status).toBe(3);
    const missing = f.answer('01UNKNOWNRUN00000000000000', 'human-1', 'yes');
    expect(missing.status, missing.stderr + missing.stdout).toBe(2);
    expect(JSON.parse(missing.stdout).diagnostics[0]).toMatchObject({ kind: 'run_unavailable' });
  }, 120_000);
});
