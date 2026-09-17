import { CloudFlowError } from '../cloud-http.js';
import { applyCloudPatch, downloadCloudPatch } from '../cloud-sync.js';
import type { CliIo } from '../cli.js';

/**
 * `flows sync <run-id>`: fetch the diff a hosted run left in its synced tree
 * and apply it here. The patch is the sandbox's own `git diff` against the
 * uploaded baseline, so applying it reproduces exactly what the run's steps
 * wrote — no re-execution, no re-upload.
 */
export async function runCloudSyncCli(
  { runId, json, root }: { runId: string; json: boolean; root: string },
  io: CliIo,
): Promise<0 | 1 | 2> {
  try {
    const { patch, hasChanges } = await downloadCloudPatch(runId, {});
    if (!hasChanges || !patch.trim()) {
      if (json) io.stdout(JSON.stringify({ ok: true, runId, hasChanges: false, applied: false }));
      else io.stdout(`NO CHANGES ${runId}`);
      return 0;
    }
    applyCloudPatch(root, patch);
    const files = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gmu)].map(match => match[1]!);
    if (json) io.stdout(JSON.stringify({ ok: true, runId, hasChanges: true, applied: true, files }));
    else io.stdout(`APPLIED ${runId}: ${files.length} file${files.length === 1 ? '' : 's'}${files.length ? `\n  ${files.join('\n  ')}` : ''}`);
    return 0;
  } catch (error) {
    const code = error instanceof CloudFlowError ? error.code : 'cloud_sync_failed';
    const message = error instanceof Error ? error.message : 'Cloud sync failed.';
    if (json) io.stdout(JSON.stringify({ ok: false, code, message, runId }));
    else io.stderr(`${code}: ${message} (run ${runId})`);
    return error instanceof CloudFlowError && ['configuration', 'sync_unsupported', 'patch_conflict'].includes(error.code) ? 2 : 1;
  }
}
