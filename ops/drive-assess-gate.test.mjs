// The assess-gate escalation test, executed rather than asserted about.
//
// ops/NEEDS_HUMAN.md was committed to main on 2026-09-06 (082c62aa) and
// nothing has ever deleted it. The gate escalated on the file's mere
// EXISTENCE, so from 2026-09-12 every drive tick exited 75 before doing any
// work: PRs #417, #420, #422, #424, #426, #427 and #428 are seven consecutive
// cloud runs whose entire diff is ops/NEEDS_HUMAN.md and ops/NEXT.md.
//
// The fix requires two independent signals to agree — the file exists AND
// this tick wrote it — so these tests drive BOTH directions. A gate that
// cannot fire is as broken as one that always fires, so the stale case and
// the live case are equally load-bearing here.
//
// The gate script is EXTRACTED from workflows/drive.yaml rather than copied,
// so this test fails if someone edits the workflow and not the test. No YAML
// parser is available at the repo root (there is no root package.json), and
// the block is a literal scalar at a known indent, so it is read as text.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const WORKFLOW = resolve(import.meta.dirname, '../workflows/drive.yaml');

/** Pull the `command:` literal block of a named deterministic step out of the workflow. */
function gateScript(stepName) {
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
  assert.match(script, /NEEDS_HUMAN/, 'extracted the wrong block');
  return script;
}

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// A work package that satisfies the gate's later checks, so the only thing
// under test is the escalation branch.
const NEXT_MD = `# NEXT — a work package\n\n## Definition of done\n\n- \`cargo test --workspace\` must be green.\n`;

/**
 * Build a repo shaped like a drive tick: a `main` baseline, then a working
 * branch that is "this tick". `staleEscalation` puts NEEDS_HUMAN.md on the
 * baseline — the wedged state that burned seven runs.
 */
function tick(t, { staleEscalation = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'assess-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@relayflows.local');
  git(root, 'config', 'user.name', 'Gate Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  execFileSync('mkdir', ['-p', join(root, 'ops')]);
  writeFileSync(join(root, 'ops/NEXT.md'), NEXT_MD);
  if (staleEscalation) {
    writeFileSync(join(root, 'ops/NEEDS_HUMAN.md'), '# NEEDS_HUMAN — answered long ago\n');
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  git(root, 'checkout', '-q', '-b', 'flow/drive-tick');
  return root;
}

function runGate(root) {
  const result = spawnSync('sh', ['-c', gateScript('assess-gate')], {
    cwd: root,
    encoding: 'utf8',
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

test('a stale escalation committed on main does not wedge the tick', (t) => {
  const root = tick(t, { staleEscalation: true });
  // This tick writes its own work package, as assess does.
  writeFileSync(join(root, 'ops/NEXT.md'), `${NEXT_MD}\nthis tick's package\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'assess: work package for this tick');

  const { code, out } = runGate(root);
  assert.notEqual(code, 75, `the gate escalated on a stale file:\n${out}`);
  assert.match(out, /ASSESS_STALE_NEEDS_HUMAN_IGNORED/);
  assert.doesNotMatch(out, /ASSESS_BLOCKED_NEEDS_HUMAN/);
  assert.match(out, /ASSESS_GATE_PASS/);
});

test('an escalation committed by this tick still parks the run', (t) => {
  const root = tick(t);
  writeFileSync(join(root, 'ops/NEEDS_HUMAN.md'), '# NEEDS_HUMAN — a live question\n\nWhich gate?\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'assess: escalate');

  const { code, out } = runGate(root);
  assert.equal(code, 75, `a genuine escalation did not park the run:\n${out}`);
  assert.match(out, /ASSESS_BLOCKED_NEEDS_HUMAN/);
  assert.match(out, /a live question/, 'the escalation body must reach the operator');
});

test('an uncommitted escalation from this tick still parks the run', (t) => {
  // Propagation between per-step sandboxes is lossy, so assess may write the
  // file and fail to commit it. An escalation must not be lost that way.
  const root = tick(t);
  writeFileSync(join(root, 'ops/NEEDS_HUMAN.md'), '# NEEDS_HUMAN — uncommitted but live\n');

  const { code, out } = runGate(root);
  assert.equal(code, 75, `an uncommitted live escalation was ignored:\n${out}`);
  assert.match(out, /ASSESS_BLOCKED_NEEDS_HUMAN/);
});

test('a tick with no escalation at all passes the gate', (t) => {
  const root = tick(t);
  writeFileSync(join(root, 'ops/NEXT.md'), `${NEXT_MD}\nthis tick's package\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'assess: work package for this tick');

  const { code, out } = runGate(root);
  assert.equal(code, 0, `a clean tick did not pass:\n${out}`);
  assert.match(out, /ASSESS_GATE_PASS/);
  assert.doesNotMatch(out, /NEEDS_HUMAN/);
});
