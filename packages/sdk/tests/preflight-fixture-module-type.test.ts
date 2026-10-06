import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PREFLIGHT = join(ROOT, 'testdata', 'preflight');
const FIXTURE = 'analyze-story-stub-cli';
const REQUEST = JSON.stringify({ protocol: 'relayflows-agent-cli-v1', instruction: 'pin' });

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** The module type `testdata/preflight` declares, or undefined when it declares none. */
function declaredType(): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(PREFLIGHT, 'package.json'), 'utf8')) as { type?: string }).type;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * The preflight fixtures, under a parent package that declares CommonJS.
 *
 * The fixtures have no file extension, so each takes its module type from the
 * nearest ancestor package.json. A checkout whose parent directory declares
 * `"type": "commonjs"` hands that to them, and node then runs an ES module as
 * CommonJS: it exits 0 having executed nothing, the handshake never happens,
 * and every agent step driven by the fixture fails with "exited before
 * completing the relayflows-agent-cli-v1 same-process handshake" and no clue
 * why. `declareModule: false` reproduces that.
 */
function fixtureTree(declareModule: boolean): string {
  const parent = mkdtempSync(join(tmpdir(), 'flows-fixture-module-'));
  temporaryDirectories.push(parent);
  writeFileSync(join(parent, 'package.json'), JSON.stringify({ name: 'host', type: 'commonjs' }));
  const directory = join(parent, 'preflight');
  mkdirSync(directory);
  if (declareModule) copyFileSync(join(PREFLIGHT, 'package.json'), join(directory, 'package.json'));
  for (const name of [FIXTURE, 'wrapper-session.mjs']) {
    copyFileSync(join(PREFLIGHT, name), join(directory, name));
  }
  return directory;
}

function identify(directory: string): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [join(directory, FIXTURE), '--relayflows-adapter-v1'], {
    input: REQUEST,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout };
}

it('declares the fixtures ES modules rather than inheriting an ancestor type', () => {
  expect(declaredType()).toBe('module');
});

it('completes the wrapper handshake under a parent package that declares commonjs', () => {
  const { status, stdout } = identify(fixtureTree(true));
  expect(status).toBe(0);
  expect(stdout.startsWith('relayflows-agent-cli-v1\nrelayflows-agent-cli-v1-execute\n')).toBe(true);
  expect(JSON.parse(stdout.split('relayflows-agent-cli-v1-execute\n')[1])).toMatchObject({ story_title: 'stub' });
});

it('silently runs nothing when the fixture directory declares no module type', () => {
  // Not an assertion about what is desirable — a record of why the declaration
  // beside the fixtures is load-bearing. Node reports no error for this.
  const { status, stdout } = identify(fixtureTree(false));
  expect(status).toBe(0);
  expect(stdout).toBe('');
});
