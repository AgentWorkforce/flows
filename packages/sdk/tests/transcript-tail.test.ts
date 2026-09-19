import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgentCli } from '../src/worker-cli.js';
import {
  openTranscriptTail, readTranscriptTail, transcriptTailPath, transcriptTailSource,
  TAIL_CAPACITY_BYTES, type TailHeader,
} from '../src/transcript-tail.js';

const directories: string[] = [];
afterEach(() => {
  // Deepest first: a read-only run dir has to be reopened before its parent goes.
  for (const directory of directories.splice(0).reverse()) {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});
function dir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'transcript-tail-'));
  directories.push(directory);
  return directory;
}

const IDENTITY = { runId: 'run-1', stepId: 'analyze', attempt: 2 };

function parse(path: string): { header: TailHeader; body: Buffer } {
  const raw = readFileSync(path);
  const newline = raw.indexOf(10);
  return { header: JSON.parse(raw.subarray(0, newline).toString()), body: raw.subarray(newline + 1) };
}

describe('openTranscriptTail', () => {
  it('writes a header line and the last 64 KiB, rewriting in place at mode 0600', async () => {
    const dataDir = dir();
    const identity = { dataDir, ...IDENTITY };
    const tail = openTranscriptTail(identity, 'stdout', 1234);
    tail.append(Buffer.from('first\n'));
    tail.append(Buffer.alloc(TAIL_CAPACITY_BYTES, 'x'));
    tail.append(Buffer.from('last\n'));
    await tail.close();
    const path = transcriptTailPath(identity, 'stdout');
    expect(path).toBe(join(dataDir, 'runs', 'run-1', 'steps', 'analyze', 'attempt-2.stdout.tail'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    const { header, body } = parse(path);
    expect(header).toEqual({ v: 1, run_id: 'run-1', step_id: 'analyze', attempt: 2, started_at_ms: 1234 });
    expect(body.length).toBe(TAIL_CAPACITY_BYTES);
    expect(body.subarray(-5).toString()).toBe('last\n');
    expect(body.indexOf('first')).toBe(-1);
    expect(existsSync(`${path}.tmp`)).toBe(false);

    // A later flush replaces the file rather than growing it.
    const again = openTranscriptTail(identity, 'stdout', 1234);
    again.append(Buffer.from('short\n'));
    await again.close();
    expect(parse(path).body.toString()).toBe('short\n');
  });

  it('keeps a chunk larger than the capacity by its tail alone', async () => {
    const identity = { dataDir: dir(), ...IDENTITY };
    const tail = openTranscriptTail(identity, 'stderr', 1);
    tail.append(Buffer.concat([Buffer.alloc(TAIL_CAPACITY_BYTES, 'a'), Buffer.from('END')]));
    await tail.close();
    const { body } = parse(transcriptTailPath(identity, 'stderr'));
    expect(body.length).toBe(TAIL_CAPACITY_BYTES);
    expect(body.subarray(-3).toString()).toBe('END');
  });

  it('warns once and keeps going when the file cannot be written', async () => {
    const dataDir = dir();
    const identity = { dataDir, ...IDENTITY };
    mkdirSync(join(dataDir, 'runs', 'run-1'), { recursive: true });
    chmodSync(join(dataDir, 'runs', 'run-1'), 0o500);
    directories.push(join(dataDir, 'runs', 'run-1'));
    const warnings: string[] = [];
    const tail = openTranscriptTail(identity, 'stdout', 1, (message) => warnings.push(message));
    tail.append(Buffer.from('one\n'));
    await tail.close();
    tail.append(Buffer.from('ignored after close\n'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('run-1/analyze attempt 2 (stdout) could not be written');
    expect(existsSync(transcriptTailPath(identity, 'stdout'))).toBe(false);
  });
});

describe('readTranscriptTail', () => {
  it('returns the body for a matching header and nothing for absent, foreign or stale files', async () => {
    const identity = { dataDir: dir(), ...IDENTITY };
    expect(await readTranscriptTail(identity, 'stdout', null)).toBeUndefined();
    const tail = openTranscriptTail(identity, 'stdout', 5000);
    tail.append(Buffer.from('hello\nworld\n'));
    await tail.close();
    expect(await readTranscriptTail(identity, 'stdout', 4000)).toMatchObject({ bytes: 12, text: 'hello\nworld\n', header: { started_at_ms: 5000 } });
    expect(await readTranscriptTail(identity, 'stdout', 5000)).toBeDefined();
    // Written before the journal says this attempt began: a previous life's file.
    expect(await readTranscriptTail(identity, 'stdout', 5001)).toBeUndefined();
    expect(await readTranscriptTail({ ...identity, attempt: 3 }, 'stdout', null)).toBeUndefined();
    const path = transcriptTailPath(identity, 'stdout');
    writeFileSync(path, '{"v":1,"run_id":"other","step_id":"analyze","attempt":2,"started_at_ms":1}\nbody');
    expect(await readTranscriptTail(identity, 'stdout', null)).toBeUndefined();
    writeFileSync(path, 'not json\nbody');
    expect(await readTranscriptTail(identity, 'stdout', null)).toBeUndefined();
  });
});

describe('direct agent spawn', () => {
  it('tees stdout and stderr into tail files that name the dispatch', async () => {
    const dataDir = dir();
    const cli = join(dataDir, 'claude');
    writeFileSync(cli, `#!/usr/bin/env node
process.stdout.write('out line 1\\nout line 2\\n');
process.stderr.write('err line 1\\n');
`, { mode: 0o755 });
    const before = Date.now();
    const result = await runAgentCli(cli, 'go', undefined, 'unpriced-test-model', undefined, undefined, 'agent', {
      dataDir, runId: 'run-9', stepId: 'analyze', attempt: 4, onDrive() {},
    });
    expect(result.exit_code).toBe(0);
    const identity = { dataDir, runId: 'run-9', stepId: 'analyze', attempt: 4 };
    for (const stream of ['stdout', 'stderr'] as const) {
      const path = transcriptTailPath(identity, stream);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const { header, body } = parse(path);
      expect(header).toMatchObject({ v: 1, run_id: 'run-9', step_id: 'analyze', attempt: 4 });
      expect(header.started_at_ms).toBeGreaterThanOrEqual(before);
      expect(body.toString()).toBe(stream === 'stdout' ? 'out line 1\nout line 2\n' : 'err line 1\n');
    }
  });

  it('completes the step when the tail directory cannot be created', async () => {
    const dataDir = dir();
    const cli = join(dataDir, 'claude');
    writeFileSync(cli, `#!/usr/bin/env node\nprocess.stdout.write('fine');\n`, { mode: 0o755 });
    mkdirSync(join(dataDir, 'runs', 'run-9'), { recursive: true });
    chmodSync(join(dataDir, 'runs', 'run-9'), 0o500);
    directories.push(join(dataDir, 'runs', 'run-9'));
    const warnings: string[] = [];
    const onWarning = (warning: Error): void => { warnings.push(warning.message); };
    process.on('warning', onWarning);
    try {
      const result = await runAgentCli(cli, 'go', undefined, 'unpriced-test-model', undefined, undefined, 'agent', {
        dataDir, runId: 'run-9', stepId: 'analyze', attempt: 1, onDrive() {},
      });
      expect(result).toMatchObject({ exit_code: 0, stdout_tail: 'fine' });
      await new Promise((resolve) => setImmediate(resolve));
    } finally { process.off('warning', onWarning); }
    // One warning: stdout had bytes to flush; stderr never did, so it never tried.
    expect(warnings.filter((message) => message.includes('could not be written'))).toHaveLength(1);
    expect(existsSync(join(dataDir, 'runs', 'run-9', 'steps'))).toBe(false);
  });
});

// --- review findings on flows#492 ------------------------------------------

describe('transcriptTailSource redaction', () => {
  async function tailLines(text: string, env: NodeJS.ProcessEnv, lines = 10): Promise<string[]> {
    const identity = { dataDir: dir(), ...IDENTITY };
    const tail = openTranscriptTail(identity, 'stdout', 1000);
    tail.append(Buffer.from(text));
    await tail.close();
    const step = { id: IDENTITY.stepId, type: 'agent', attempt: IDENTITY.attempt, started_at_ms: 1000 } as never;
    const tails = await transcriptTailSource(env).read(identity.dataDir, IDENTITY.runId, step, lines);
    return tails?.stdout?.lines ?? [];
  }

  it('redacts a multiline secret the agent printed across lines', async () => {
    // `lastLines` split before it redacted, so no single line held the whole
    // env value and `replaceAll` matched none of the pieces.
    const env = { DEPLOY_PRIVATE_KEY: 'line-one\nline-two\nline-three' };
    const lines = await tailLines(`before\n${env.DEPLOY_PRIVATE_KEY}\nafter\n`, env);
    const joined = lines.join('\n');
    expect(joined).not.toContain('line-two');
    expect(joined).toContain('[redacted:DEPLOY_PRIVATE_KEY]');
    expect(joined).toContain('before');
    expect(joined).toContain('after');
  });

  it('still redacts a single-line secret and leaves ordinary text alone', async () => {
    const env = { GH_TOKEN: 'abcdefghij' };
    const lines = await tailLines('ok\nusing abcdefghij now\n', env);
    expect(lines).toEqual(['ok', 'using [redacted:GH_TOKEN] now']);
  });

  it('keeps the last N lines after redacting the whole text', async () => {
    const lines = await tailLines('a\nb\nc\nd\ne\n', {}, 2);
    expect(lines).toEqual(['d', 'e']);
  });
});
