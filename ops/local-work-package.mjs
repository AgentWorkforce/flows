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
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const packagePath = '.relayflow/drive-local/package.json';
const backlogPath = 'ops/BACKLOG.md';
// The picker's own module, not the package index: index.js re-exports
// packageFromEntry and validateWorkPackage but NOT selectBacklogEntry or
// renderWorkPackage, so importing the index gets you two of the four.
const sdkEntry = new URL('../packages/sdk/dist/backlog-picker.js', import.meta.url);

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
    // The flow builds the SDK before this step; a failure here means that
    // step did not run or did not finish.
    throw new Error(
      `SDK_NOT_BUILT: ${sdkEntry.pathname} is not importable — run the build step first`,
      { cause },
    );
  }
}

async function select() {
  const { selectBacklogEntry, packageFromEntry, validateWorkPackage, renderWorkPackage } =
    await loadPicker();
  const markdown = read(backlogPath);
  const entry = selectBacklogEntry(markdown);
  assert(entry, `BACKLOG_EMPTY: no selectable entry in ${backlogPath}`);

  const candidate = packageFromEntry(entry);
  const validation = validateWorkPackage(candidate);
  // Refuse rather than hand an agent an underspecified package. A tick that
  // starts without a definition of done cannot tell whether it finished.
  assert(
    validation.accepted,
    `WORK_PACKAGE_REJECTED: ${validation.accepted ? '' : validation.reason} — ${entry.title}`,
  );

  const pkg = {
    selectedAt: new Date().toISOString(),
    branch: git('branch', '--show-current'),
    head: git('rev-parse', 'HEAD'),
    backlogSha256: hash(markdown),
    title: validation.work.title,
    filesInScope: validation.work.files_in_scope,
    definitionOfDone: validation.work.definition_of_done,
    brief: renderWorkPackage(entry),
  };
  writeAtomically(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`SELECTED ${pkg.title}`);
  console.log(`  files in scope: ${pkg.filesInScope.join(', ')}`);
  console.log(`  definition of done: ${pkg.definitionOfDone.length} item(s)`);
}

function report() {
  const pkg = JSON.parse(read(packagePath));
  // The package pins the HEAD it was selected against. Reporting a diff from a
  // different commit would describe work this tick did not do.
  const head = git('rev-parse', 'HEAD');
  assert.equal(head, pkg.head, `HEAD_MOVED: selected at ${pkg.head}, now ${head}`);
  const stat = git('diff', '--stat');
  console.log(`REPORT ${pkg.title}`);
  console.log(stat || '  (no working-tree changes)');
  for (const item of pkg.definitionOfDone) console.log(`  DoD: ${item}`);
}

const command = process.argv[2];
if (command === 'select') await select();
else if (command === 'report') report();
else {
  console.error('usage: local-work-package.mjs <select|report>');
  process.exit(2);
}
