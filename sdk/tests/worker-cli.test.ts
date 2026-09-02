import {
  chmodSync,
  existsSync,
  mkdtempSync,
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

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'flows-wrapper-'));
  directories.push(directory);
  return directory;
}

function makeWrapper(directory: string, name: string, source: string): string {
  const wrapper = join(directory, name);
  writeFileSync(wrapper, `#!/usr/bin/env node\n${source}`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

async function withEnvironment<T>(
  values: Record<string, string>,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    prior.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe('custom wrapper execution identity', () => {
  it('passes an explicit safe environment at identification and execution', async () => {
    const directory = makeDirectory();
    const wrapper = makeWrapper(directory, 'environment-wrapper', `
const secretNames = [
  'RELAYFLOW_MODEL',
  'RELAYFLOW_WAKE_CONTEXT',
  'RELAYFLOWS_TEST_SECRET',
  'AWS_SECRET_ACCESS_KEY',
  'GITHUB_TOKEN',
];
const snapshot = () => Object.fromEntries(secretNames.map(name => [name, process.env[name] ?? null]));
const identificationEnvironment = snapshot();
process.stdout.write('relayflows-agent-cli-v1\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  const executionEnvironment = snapshot();
  process.stdout.write(JSON.stringify({
    identificationEnvironment,
    executionEnvironment,
    pathPresent: typeof process.env.PATH === 'string' && process.env.PATH.length > 0,
    instruction: request.instruction,
    model: request.model,
    wakeContext: request.wakeContext,
  }));
});
`);

    const result = await withEnvironment({
      RELAYFLOW_MODEL: 'ambient-model',
      RELAYFLOW_WAKE_CONTEXT: 'ambient-wake',
      RELAYFLOWS_TEST_SECRET: 'private-test-secret',
      AWS_SECRET_ACCESS_KEY: 'private-aws-secret',
      GITHUB_TOKEN: 'private-github-token',
    }, () => runAgentCli(wrapper, 'private instruction', { private: 'wake' }, 'private-model'));

    expect(result).toMatchObject({ exit_code: 0, stderr_tail: '' });
    expect(JSON.parse(result.stdout_tail)).toEqual({
      identificationEnvironment: {
        RELAYFLOW_MODEL: null,
        RELAYFLOW_WAKE_CONTEXT: null,
        RELAYFLOWS_TEST_SECRET: null,
        AWS_SECRET_ACCESS_KEY: null,
        GITHUB_TOKEN: null,
      },
      executionEnvironment: {
        RELAYFLOW_MODEL: null,
        RELAYFLOW_WAKE_CONTEXT: null,
        RELAYFLOWS_TEST_SECRET: null,
        AWS_SECRET_ACCESS_KEY: null,
        GITHUB_TOKEN: null,
      },
      pathPresent: true,
      instruction: 'private instruction',
      model: 'private-model',
      wakeContext: { private: 'wake' },
    });
  });

  it('refuses a wrapper symlink retarget before delivering private values', async () => {
    const directory = makeDirectory();
    const declared = join(directory, 'declared-wrapper');
    const requestEvidence = join(directory, 'trusted-request-evidence.json');
    const replacementEvidence = join(directory, 'replacement-evidence.json');
    const replacement = makeWrapper(directory, 'replacement-wrapper', `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(replacementEvidence)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write('{"replacement":true}');
`);
    const trusted = makeWrapper(directory, 'trusted-wrapper', `
const fs = require('node:fs');
if (process.argv[2] !== '--relayflows-adapter-v1') process.exit(90);
process.stdout.cork();
process.stdout.write('relayflows-agent-cli-v1\\n');
const next = ${JSON.stringify(declared)} + '.next';
fs.symlinkSync(${JSON.stringify(replacement)}, next);
fs.renameSync(next, ${JSON.stringify(declared)});
process.stdout.uncork();
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  if (input.trim() !== '') {
    fs.writeFileSync(${JSON.stringify(requestEvidence)}, input);
    process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  }
});
`);
    symlinkSync(trusted, declared);

    const result = await runAgentCli(
      declared,
      'MUST_NOT_CROSS_RETARGET',
      { private: 'wake' },
      'private-model',
    );

    expect(result.exit_code).toBeNull();
    expect(result.stderr_tail).toMatch(/identity changed/i);
    expect(realpathSync(declared)).toBe(realpathSync(replacement));
    expect(existsSync(requestEvidence)).toBe(false);
    expect(existsSync(replacementEvidence)).toBe(false);
  });

  it('bounds wrapper execution after acknowledgement', async () => {
    const directory = makeDirectory();
    const wrapper = makeWrapper(directory, 'slow-wrapper', `
process.stdout.write('relayflows-agent-cli-v1\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  setTimeout(() => process.exit(0), 250);
});
`);

    const result = await runAgentCli(wrapper, 'instruction', undefined, undefined, {
      executionTimeoutMs: 50,
    });

    expect(result.exit_code).toBeNull();
    expect(result.stderr_tail).toMatch(/timed out after 50ms/i);
  });

  it('bounds captured wrapper output', async () => {
    const directory = makeDirectory();
    const wrapper = makeWrapper(directory, 'noisy-wrapper', `
process.stdout.write('relayflows-agent-cli-v1\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  process.stdout.write('x'.repeat(80));
  process.stderr.write('y'.repeat(80));
});
`);

    const result = await runAgentCli(wrapper, 'instruction', undefined, undefined, {
      maxOutputBytes: 128,
    });

    expect(result.exit_code).toBeNull();
    expect(result.stderr_tail).toMatch(/output limit of 128 bytes/i);
  });

  it('refuses a duplicate execute protocol frame', async () => {
    const directory = makeDirectory();
    const wrapper = makeWrapper(directory, 'duplicate-frame-wrapper', `
process.stdout.write('relayflows-agent-cli-v1\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  process.stdout.write('{"mustNotBeAccepted":true}');
});
`);

    const result = await runAgentCli(wrapper, 'instruction', undefined);

    expect(result.exit_code).toBeNull();
    expect(result.stdout_tail).toBe('');
    expect(result.stderr_tail).toMatch(/duplicate execute protocol frame/i);
  });
});
