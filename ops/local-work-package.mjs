// Select one work package from ops/BACKLOG.md for a local drive tick.
//
// This used to hardcode a single item. The constants at the top named one file,
// one old identifier and one new one, and `select` asserted that BACKLOG still
// contained that exact entry. It proved a relayflow could drive a real change on
// this checkout, which was the point at the time, but it could only ever drive
// that one change — every later tick needed a human to rewrite the script first.
//
// Selection now comes from the SDK's backlog picker (gate 3, PR #20), which is
// the same rule the cloud drive uses: the first top-level bullet whose title is
// bold, validated for a title, files in scope, and a definition of done. Using
// it here rather than a second implementation means the local loop and the cloud
// loop cannot drift into disagreeing about what "the next work package" is.
//
// Implementation is no longer this script's job. A mechanical rewrite is the
// only kind of change a deterministic step can make, and most backlog entries
// are not mechanical. The flow now hands the package to an agent step, which is
// what makes the loop general.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { checkScope, runChecks, verificationCommands } from './local-work-verification.mjs';

const packagePath = '.relayflow/drive-local/package.json';
const backlogPath = 'ops/BACKLOG.md';
// The picker's own module, not the package index: index.js re-exports
// packageFromEntry and validateWorkPackage but NOT selectBacklogEntry or
// renderWorkPackage, so importing the index gets you two of the four.
// The gate must not execute code the agent it judges can rewrite. The scope
// guard protects packages/sdk/src/backlog-picker.ts, but this imports the BUILT
// dist/backlog-picker.js -- an agent can leave the source untouched, rebuild
// dist, and the guard still passes. DRIVE_GATE_PICKER pins an immutable
// pre-implementation snapshot instead.
const sdkEntry = process.env.DRIVE_GATE_PICKER
  ? new URL(`file://${process.env.DRIVE_GATE_PICKER}`)
  : new URL('../packages/sdk/dist/backlog-picker.js', import.meta.url);

const read = (p) => readFileSync(p, 'utf8');
const hash = (t) => createHash('sha256').update(t).digest('hex');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();

// A killed writer leaves the destination wholly old or wholly new. Flush the
// replacement before rename and the containing directory before reporting it.
function writeAtomically(path, contents) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporary, contents, { mode: 0o600 });
  const handle = openSync(temporary, 'r');
  try { fsyncSync(handle); } finally { closeSync(handle); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

async function loadPicker() {
  try {
    return await import(sdkEntry.href);
  } catch (cause) {
    // Say which build is missing rather than surfacing a bare module error.
    // Building the SDK is a launcher prerequisite, not a step in this flow.
    throw new Error(
      `SDK_NOT_BUILT: ${sdkEntry.pathname} is not importable — run the build step first`,
      { cause },
    );
  }
}

async function choose(markdown, { pathExists = existsSync, log = true } = {}) {
  const { selectBacklogEntry, packageFromEntry, validateWorkPackage, renderWorkPackage } =
    await loadPicker();
  const skipped = [];
  let entry = null;
  let validation = null;

  // Take the first entry this loop can actually bound. The picker returns one
  // entry -- the first top-level bullet with a bold title -- so "next" is found
  // by removing the one just rejected and asking it again, rather than writing
  // a second parser that could disagree with it about what an entry is.
  let commands;
  while (markdown.length > 0) {
    const candidateEntry = selectBacklogEntry(markdown);
    if (!candidateEntry) break;

    const candidate = packageFromEntry(candidateEntry);
    const result = validateWorkPackage(candidate);
    const scope = result.accepted ? result.work.files_in_scope : [];

    // The picker emits ['.'] when an entry references code but names no path.
    // That is deliberate on its side -- its comment calls it "honest breadth" --
    // and it is a fair description of the entry. It is not usable as scope for
    // an agent: "." is the whole repository, and an agent told its scope is
    // everything has been told nothing. Skip rather than widen what an
    // unattended tick may touch.
    const unbounded = scope.length === 1 && scope[0] === '.';

    // A path that no longer exists is not scope either. Backlog entries outlive
    // the tree they were written against -- this repo moved `sdk/` to
    // `packages/sdk/`, so entries naming `sdk/src/protocol.ts` still read as
    // precise while pointing at nothing. An agent handed four missing files
    // will either invent work or widen scope to find something, and both are
    // failures the flow's instruction explicitly forbids. Skipping here means a
    // rotted entry can never silently become an agent's instruction, and the
    // skip line names the missing paths so the entry can be repaired.
    const missing = unbounded ? [] : scope.filter((path) => !pathExists(path));
    const checks = verificationCommands(candidateEntry.body);

    if (result.accepted && !unbounded && missing.length === 0 && checks.length > 0) {
      entry = candidateEntry;
      validation = result;
      commands = checks;
      break;
    }
    skipped.push({
      title: candidateEntry.title,
      reason: !result.accepted
        ? result.reason
        : unbounded
          ? 'unbounded_scope'
          : missing.length > 0
            ? `stale_scope: ${missing.join(', ')}`
            : 'missing_executable_checks',
    });
    // Locate the bullet the SDK matched, never a mention of its title in an
    // earlier entry's body. Consuming the full line guarantees forward progress.
    const lines = markdown.split('\n');
    const at = lines.findIndex(line => line.startsWith(`- **${candidateEntry.title}**`));
    assert(at >= 0, 'BACKLOG_CURSOR_LOST');
    markdown = lines.slice(at + 1).join('\n');
  }

  if (log) for (const s of skipped) console.log(`SKIPPED [${s.reason}] ${s.title.slice(0, 90)}`);
  assert(
    entry && validation?.accepted,
    `NO_BOUNDED_WORK: ${skipped.length} entr(y|ies) considered, none named files ` +
      `this loop can scope and verify. Add explicit paths and Verify: JSON argv to a BACKLOG entry.`,
  );

  return {
    title: validation.work.title,
    filesInScope: validation.work.files_in_scope,
    definitionOfDone: validation.work.definition_of_done,
    verificationCommands: commands,
    brief: renderWorkPackage(entry),
  };
}

async function select() {
  // Restored guard. The generalization recorded the branch but stopped asserting
  // it, so the loop would happily select work while sitting on `main` and let
  // the agent edit the protected branch. `--show-current` prints nothing on a
  // detached HEAD, which is equally not a work branch.
  const branch = git('branch', '--show-current');
  assert(
    branch && branch !== 'main',
    branch
      ? `LOCAL_DRIVE_REFUSED: on '${branch}'; use a work branch, not main`
      : 'LOCAL_DRIVE_REFUSED: detached HEAD is not a work branch; check out one',
  );
  const head = git('rev-parse', 'HEAD');
  const markdown = read(backlogPath);
  // Selection and the gate must share one baseline. `existsSync` accepts a path
  // that exists only in the working tree, which selection then persists and
  // checkScope immediately rejects -- its `git cat-file` lookup consults the
  // selected commit, so an untracked path aborts the run on a package selection
  // had already blessed. Committed-at-HEAD is the honest rule for both: scope is
  // a claim about reviewable content, and an untracked path is not yet that.
  const work = await choose(markdown, {
    pathExists: path => spawnSync('git', ['cat-file', '-e', `${head}:${path.replace(/\/$/, '')}`],
      { stdio: 'ignore' }).status === 0,
  });
  const pkg = {
    selectedAt: new Date().toISOString(),
    branch,
    head,
    backlogSha256: hash(markdown),
    ...work,
  };
  writeAtomically(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`SELECTED ${pkg.title}`);
  console.log(`  files in scope: ${pkg.filesInScope.join(', ')}`);
  console.log(`  definition of done: ${pkg.definitionOfDone.length} item(s)`);
}

async function verifiedPackage() {
  const pkg = JSON.parse(read(packagePath));
  assert.equal(git('rev-parse', 'HEAD'), pkg.head, 'HEAD_MOVED');
  assert.equal(git('branch', '--show-current'), pkg.branch, 'BRANCH_MOVED');
  const markdown = read(backlogPath);
  assert.equal(hash(markdown), pkg.backlogSha256, 'BACKLOG_CHANGED');
  // Reconstruct from the unchanged backlog, so editing ignored package.json
  // cannot widen scope or replace acceptance commands with `true`.
  const selected = await choose(markdown, {
    log: false,
    // Consult the selected commit so deleting an in-scope file neither shifts
    // selection nor resurrects an earlier entry with stale paths.
    pathExists: path => spawnSync('git', ['cat-file', '-e', `${pkg.head}:${path.replace(/\/$/, '')}`],
      { stdio: 'ignore' }).status === 0,
  });
  for (const key of Object.keys(selected)) {
    assert.deepEqual(pkg[key], selected[key], `PACKAGE_CHANGED: ${key}`);
  }
  checkScope(pkg);
  return pkg;
}

function report() {
  const pkg = JSON.parse(read(packagePath));
  // The package pins the HEAD it was selected against. Reporting a diff from a
  // different commit would describe work this tick did not do.
  const head = git('rev-parse', 'HEAD');
  assert.equal(head, pkg.head, `HEAD_MOVED: selected at ${pkg.head}, now ${head}`);
  const stat = [
    git('diff', 'HEAD', '--stat'),
    git('ls-files', '--others', '--exclude-standard'),
  ].filter(Boolean).join('\n');
  console.log(`REPORT ${pkg.title}`);
  console.log(stat || '  (no working-tree changes)');
  for (const item of pkg.definitionOfDone) console.log(`  DoD: ${item}`);
}

const command = process.argv[2];
if (command === 'select') await select();
else if (command === 'report') report();
else if (command === 'scope') await verifiedPackage();
else if (command === 'verify') {
  const pkg = await verifiedPackage();
  runChecks(pkg);
  await verifiedPackage();
}
else {
  console.error('usage: local-work-package.mjs <select|scope|verify|report>');
  process.exit(2);
}
