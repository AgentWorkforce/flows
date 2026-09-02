import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgentCli } from '../src/worker-cli.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('custom wrapper execution identity', () => {
  it('keeps identification and private execution on one process when an absolute symlink retargets', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'flows-wrapper-symlink-'));
    directories.push(directory);
    const trusted = join(directory, 'trusted-wrapper');
    const replacement = join(directory, 'replacement-wrapper');
    const declared = join(directory, 'declared-wrapper');
    const evidence = join(directory, 'replacement-evidence.json');

    writeFileSync(replacement, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({
  argv: process.argv.slice(2),
  model: process.env.RELAYFLOW_MODEL ?? null,
  wake: process.env.RELAYFLOW_WAKE_CONTEXT ?? null,
}));
process.stdout.write('{"replacement":true}');
`);
    chmodSync(replacement, 0o755);
    writeFileSync(trusted, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] !== '--relayflows-adapter-v1') process.exit(90);
const ambientModel = process.env.RELAYFLOW_MODEL ?? null;
const ambientWake = process.env.RELAYFLOW_WAKE_CONTEXT ?? null;
process.stdout.write('relayflows-agent-cli-v1\\n');
const next = ${JSON.stringify(declared)} + '.next';
fs.symlinkSync(${JSON.stringify(replacement)}, next);
fs.renameSync(next, ${JSON.stringify(declared)});
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  if (input.trim() === '') process.exit(0);
  const request = JSON.parse(input);
  process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  process.stdout.write(JSON.stringify({
    trusted: true,
    instruction: request.instruction,
    model: request.model,
    wakeContext: request.wakeContext,
    ambientModel,
    ambientWake,
    argv: process.argv.slice(2),
  }));
});
`);
    chmodSync(trusted, 0o755);
    symlinkSync(trusted, declared);

    const priorModel = process.env.RELAYFLOW_MODEL;
    const priorWake = process.env.RELAYFLOW_WAKE_CONTEXT;
    process.env.RELAYFLOW_MODEL = 'ambient-model-must-not-cross';
    process.env.RELAYFLOW_WAKE_CONTEXT = 'ambient-wake-must-not-cross';
    const result = await runAgentCli(
      declared,
      'MUST_STAY_WITH_IDENTIFIED_PROCESS',
      { private: 'wake' },
      'private-model',
    );
    if (priorModel === undefined) delete process.env.RELAYFLOW_MODEL;
    else process.env.RELAYFLOW_MODEL = priorModel;
    if (priorWake === undefined) delete process.env.RELAYFLOW_WAKE_CONTEXT;
    else process.env.RELAYFLOW_WAKE_CONTEXT = priorWake;

    expect(result).toMatchObject({ exit_code: 0 });
    expect(JSON.parse(result.stdout_tail)).toEqual({
      trusted: true,
      instruction: 'MUST_STAY_WITH_IDENTIFIED_PROCESS',
      model: 'private-model',
      wakeContext: { private: 'wake' },
      ambientModel: null,
      ambientWake: null,
      argv: ['--relayflows-adapter-v1'],
    });
    expect(realpathSync(declared)).toBe(realpathSync(replacement));
    expect(existsSync(evidence) ? readFileSync(evidence, 'utf8') : undefined).toBeUndefined();
  });
});
