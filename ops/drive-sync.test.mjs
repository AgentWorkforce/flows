// The sync step's self-materialize behaviour, executed rather than asserted about.
//
// A synced `agent-relay cloud run` uploads the working tree, so its sandbox
// boots with the repo present. A Cloud schedule does NOT: `agent-relay cloud
// schedule` stores only the workflow text and Cloud rejects an s3CodeKey on a
// scheduled request, so the sandbox boots EMPTY. Every tick of schedule
// flows-v2-lead-tick-0903 died at the sync gate with SYNC_FAIL_NOT_MATERIALIZED
// (dev run 1c6179c9). A scheduled v1 sandbox also gets no GH_TOKEN and no git
// credential — but AgentWorkforce/flows is public, so sync clones it with no
// credential at all and reaches the same tree a synced run would.
//
// The sync script is EXTRACTED from workflows/drive.yaml rather than copied, so
// this test fails if someone edits the workflow and not the test. No YAML
// parser is available at the repo root (there is no root package.json) and the
// block is a literal scalar at a known indent, so it is read as text — the same
// technique ops/drive-assess-gate.test.mjs uses.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const WORKFLOW = resolve(import.meta.dirname, '../workflows/drive.yaml');

/** Pull the `command:` literal block of a named deterministic step out of the workflow. */
function stepScript(stepName) {
  const lines = readFileSync(WORKFLOW, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  assert.notEqual(start, -1, `no step named ${stepName} in workflows/drive.yaml`);
  const commandAt = lines.findIndex((line, i) => i > start && line.trim() === 'command: |');
  assert.notEqual(commandAt, -1, `step ${stepName} has no literal command block`);
  const indent = lines[commandAt].search(/\S/) + 2;
  const body = [];
  for (const line of lines.slice(commandAt + 1)) {
    if (line.trim() !== '' && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  const script = body.join('\n');
  assert.match(script, /SYNC_MATERIALIZED/, 'extracted the wrong block');
  return script;
}

const SYNC = stepScript('sync');

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// The paths the sync gate requires before it declares the tree materialized.
const REQUIRED = [
  'AGENTS.md',
  'docs/RFC-0001-everything-is-a-relayflow.md',
  'ops/DIRECTIVES.md',
  'kernel',
  'packages/sdk',
];

/** Write the required-path skeleton into a directory. */
function writeRepoSkeleton(root, marker) {
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'ops'), { recursive: true });
  mkdirSync(join(root, 'kernel'), { recursive: true });
  mkdirSync(join(root, 'packages/sdk'), { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), `# AGENTS ${marker}\n`);
  writeFileSync(join(root, 'docs/RFC-0001-everything-is-a-relayflow.md'), `# RFC-0001 ${marker}\n`);
  writeFileSync(join(root, 'ops/DIRECTIVES.md'), `# DIRECTIVES ${marker}\n`);
  writeFileSync(join(root, 'kernel/.keep'), '');
  writeFileSync(join(root, 'packages/sdk/package.json'), '{"name":"sdk"}\n');
}

/**
 * A stand-in for the public AgentWorkforce/flows: a real git repo on `main`
 * that sync can fetch over file://. Its AGENTS.md carries a marker so the test
 * can prove the tree actually came from the remote, not from the sandbox.
 */
function makeRemoteRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'sync-remote-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@relayflows.local');
  git(root, 'config', 'user.name', 'Sync Test Remote');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeRepoSkeleton(root, 'FROM_REMOTE');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'remote base');
  return root;
}

/** An empty sandbox, as a Cloud schedule produces: no code, no git, no origin. */
function emptySandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'sync-sandbox-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function runSync(root, env = {}) {
  const result = spawnSync('sh', ['-c', SYNC], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

test('a scheduled sandbox with no working tree self-materializes from the public repo', (t) => {
  const remote = makeRemoteRepo(t);
  const sandbox = emptySandbox(t);

  const { code, out } = runSync(sandbox, { FLOWS_REPO_URL: `file://${remote}` });

  assert.equal(code, 0, `sync did not recover an empty sandbox:\n${out}`);
  assert.match(out, /SYNC_SELF_MATERIALIZE:/, 'it must announce the self-heal');
  assert.match(out, /SYNC_SELF_MATERIALIZED:/, 'the fetch+checkout must succeed');
  assert.match(out, /SYNC_MATERIALIZED=ok/, 'the required-path gate must pass after the clone');
  assert.match(out, /SYNC_MODE=remote/, 'the cloned origin drives the remote path');
  assert.match(out, /^SYNCED$/m, 'the step must finish');
  for (const p of REQUIRED) {
    assert.ok(existsSync(join(sandbox, p)), `required path ${p} missing after self-heal:\n${out}`);
  }
  // Prove the tree genuinely came from the remote, not from thin air.
  assert.match(readFileSync(join(sandbox, 'AGENTS.md'), 'utf8'), /FROM_REMOTE/);
});

test('an already-materialized tree is used as-is and is never cloned over', (t) => {
  // The synced-run / snapshot shape: an extracted tarball that the sandbox has
  // `git init`-ed with no remote. The sandbox's git defaults its first branch
  // to `master` (which is why SYNC_MODE=snapshot works in prod — runs 6b6d456e
  // and 1b0dedc8), so pin it here rather than inherit this host's
  // init.defaultBranch and diverge from the environment under test.
  const sandbox = emptySandbox(t);
  git(sandbox, 'init', '-q', '-b', 'master');
  git(sandbox, 'config', 'user.email', 'test@relayflows.local');
  git(sandbox, 'config', 'user.name', 'Sync Test Sandbox');
  git(sandbox, 'config', 'commit.gpgsign', 'false');
  writeRepoSkeleton(sandbox, 'FROM_SANDBOX');
  git(sandbox, 'add', '-A');
  git(sandbox, 'commit', '-qm', 'materialized snapshot');

  // A poisoned URL: if sync ever tried to clone here it would fail loudly.
  // It must not be consulted when the tree is already present.
  const { code, out } = runSync(sandbox, {
    FLOWS_REPO_URL: 'file:///nonexistent-sync-test-must-not-fetch',
  });

  assert.equal(code, 0, `sync failed on an already-present tree:\n${out}`);
  assert.doesNotMatch(out, /SYNC_SELF_MATERIALIZE/, 'a present tree must not trigger a clone');
  assert.match(out, /SYNC_MATERIALIZED=ok/);
  assert.match(out, /SYNC_MODE=snapshot/, 'no origin means the snapshot path');
  assert.match(out, /^SYNCED$/m);
  assert.match(readFileSync(join(sandbox, 'AGENTS.md'), 'utf8'), /FROM_SANDBOX/);
});

test('an empty sandbox fails closed when the repo cannot be fetched', (t) => {
  const sandbox = emptySandbox(t);

  const { code, out } = runSync(sandbox, {
    FLOWS_REPO_URL: 'file:///nonexistent-sync-test-unreachable',
  });

  assert.equal(code, 78, `sync must fail closed (78) when it cannot materialize:\n${out}`);
  assert.match(out, /SYNC_FAIL_NOT_MATERIALIZED/);
  assert.doesNotMatch(out, /SYNC_MATERIALIZED=ok/, 'it must not claim success');
});
