import { CloudFlowError } from '../cloud-http.js';
import {
  applyCloudPatch, downloadCloudPatchSet, excludedPatchPaths, patchedPaths, type CloudPathPatch,
} from '../cloud-sync.js';
import type { CliIo } from '../cli.js';

/**
 * `flows sync <run-id>`: fetch the diff a hosted run left in its synced tree
 * and apply it here. The patch is the sandbox's own `git diff` against the
 * uploaded baseline, so applying it reproduces exactly what the run's steps
 * wrote — no re-execution, no re-upload.
 *
 * The agent runtime's own bookkeeping inside that tree is dropped on the way
 * in (`CLOUD_SYNC_PATCH_EXCLUDES`); `--dry-run` prints the patch instead of
 * applying it, and a run that produced one patch per mounted path is shown but
 * never applied, because no single `--dir` is the right destination for all of
 * them.
 */
export async function runCloudSyncCli(
  { runId, json, root, dryRun }: { runId: string; json: boolean; root: string; dryRun: boolean },
  io: CliIo,
): Promise<0 | 1 | 2> {
  try {
    const set = await downloadCloudPatchSet(runId, {});
    if (!set.hasChanges) {
      if (json) io.stdout(JSON.stringify({ ok: true, runId, hasChanges: false, applied: false }));
      else io.stdout(`NO CHANGES ${runId}`);
      return 0;
    }
    if (set.kind === 'multi-path') {
      const changed = set.patches.filter(entry => entry.hasChanges && entry.patch.trim() !== '');
      if (!dryRun) {
        throw new CloudFlowError('sync_unsupported',
          `Run ${runId} produced ${changed.length} path-scoped patch${changed.length === 1 ? '' : 'es'} `
          + `(${changed.map(entry => entry.name).join(', ')}); flows sync applies single-tree runs only. `
          + 'Inspect them with --dry-run, then apply each in its own repository.');
      }
      reportMultiPathDryRun(runId, changed, json, io);
      return 0;
    }
    if (dryRun) {
      reportDryRun(runId, set.patch, json, io);
      return 0;
    }
    const { files, excluded } = applyCloudPatch(root, set.patch);
    if (json) io.stdout(JSON.stringify({ ok: true, runId, hasChanges: true, applied: true, files, excluded }));
    else {
      io.stdout(`APPLIED ${runId}: ${files.length} file${files.length === 1 ? '' : 's'}${indented(files)}`);
      if (excluded.length) io.stdout(`SKIPPED agent runtime paths: ${excluded.length}${indented(excluded)}`);
      io.stdout('Applied to the working tree, uncommitted: review with git diff before keeping it.');
    }
    return 0;
  } catch (error) {
    const code = error instanceof CloudFlowError ? error.code : 'cloud_sync_failed';
    const message = error instanceof Error ? error.message : 'Cloud sync failed.';
    if (json) io.stdout(JSON.stringify({ ok: false, code, message, runId }));
    else io.stderr(`${code}: ${message} (run ${runId})`);
    return error instanceof CloudFlowError && ['configuration', 'sync_unsupported', 'patch_conflict'].includes(error.code) ? 2 : 1;
  }
}

/** A single-tree patch, shown rather than applied. */
function reportDryRun(runId: string, patch: string, json: boolean, io: CliIo): void {
  const excluded = excludedPatchPaths(patch);
  const files = patchedPaths(patch).filter(path => !excluded.includes(path));
  if (json) {
    // The patch travels in the payload, not on stdout beside it: a --json
    // consumer parses one object, and a diff printed alongside it is not JSON.
    io.stdout(JSON.stringify({
      ok: true, runId, hasChanges: true, applied: false, dryRun: true, files, excluded, patch,
    }));
    return;
  }
  io.stdout(`DRY RUN ${runId}: ${files.length} file${files.length === 1 ? '' : 's'} would be written${indented(files)}`);
  if (excluded.length) io.stdout(`Would skip agent runtime paths: ${excluded.length}${indented(excluded)}`);
  emitPatch(patch, io);
}

/** Every changed path-scoped patch, shown; applying them is not this command's call. */
function reportMultiPathDryRun(
  runId: string, changed: readonly CloudPathPatch[], json: boolean, io: CliIo,
): void {
  if (json) {
    io.stdout(JSON.stringify({
      ok: true, runId, hasChanges: true, applied: false, dryRun: true, multiPath: true,
      patches: changed.map(({ name, patch }) => {
        const excluded = excludedPatchPaths(patch);
        return { name, files: patchedPaths(patch).filter(path => !excluded.includes(path)), excluded, patch };
      }),
    }));
    return;
  }
  io.stdout(`DRY RUN ${runId}: ${changed.length} path-scoped patch${changed.length === 1 ? '' : 'es'}`);
  io.stdout('Each targets its own repository; apply them there, not with --dir.');
  for (const { name, patch } of changed) {
    io.stdout(`--- patch for path "${name}" ---`);
    emitPatch(patch, io);
  }
}

/** Write a diff through the line-oriented io without gaining or losing a newline. */
function emitPatch(patch: string, io: CliIo): void {
  for (const line of patch.replace(/\n$/u, '').split('\n')) io.stdout(line);
}

function indented(paths: readonly string[]): string {
  return paths.length ? `\n  ${paths.join('\n  ')}` : '';
}
