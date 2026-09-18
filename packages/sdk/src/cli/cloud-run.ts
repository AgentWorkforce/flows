import { CloudFlowError } from '../cloud-http.js';
import { runInCloud, waitForCloudFlowRun, type RunInCloudOptions } from '../cloud-run.js';
import { DirectInputError, isAuthoredFlowPath, parseDirectInput } from '../direct-input.js';
import { snapshotJsonValue } from '../json-value.js';
import { cliConnectPrompt, ensureFlowConnections, harnessRemedy } from './cloud-connect-cli.js';
import type { CliIo } from '../cli.js';

/** Presentation only: the central CLI parser owns argv; the SDK owns the lifecycle. */
export async function runCloudCli(
  { value: path, json, wait, input, syncCode, noConnect = false }: {
    value: string; json: boolean; wait: boolean; input: string | undefined; syncCode: boolean; noConnect?: boolean;
  },
  io: CliIo,
): Promise<0 | 1 | 2> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let runId: string | undefined;
  // Flips at the run submission. An interruption before it — during prepare,
  // packing or upload — admitted nothing and is safe to retry; only an
  // interrupted submission has unknown admission.
  let submitting = false;
  let harnesses: readonly string[] = [];
  try {
    const options: RunInCloudOptions = { signal: controller.signal, onSubmit: () => { submitting = true; } };
    // Before anything is packed or uploaded: a helper the run would call
    // against an unconnected integration is connected here, or refused here.
    const connections = await ensureFlowConnections({
      path, prompt: cliConnectPrompt(io, { noConnect, json }),
    }, { signal: controller.signal });
    harnesses = connections?.requirements.harnesses ?? [];
    for (const provider of connections?.outcome.connected ?? []) if (!json) io.stdout(`CONNECTED ${provider}`);
    if (isAuthoredFlowPath(path)) {
      // Same parse as a local direct run, so a file-or-inline argument means
      // the same thing on both sides of `--cloud`.
      try {
        options.input = snapshotJsonValue(parseDirectInput(input), 'Cloud authored input');
      } catch (error) {
        if (error instanceof DirectInputError) throw new CloudFlowError('invalid_input', error.message);
        throw error;
      }
    }
    // The tree is the invoking directory, as with v1: the flow path is where
    // the body lives, not the boundary of what the run may read.
    if (syncCode) options.syncCode = { root: process.cwd() };
    const receipt = await runInCloud({ path }, options);
    runId = receipt.runId;
    if (!json) {
      io.stdout(`ACCEPTED ${receipt.runId} (${receipt.status})`);
      io.stdout(receipt.apiUrl);
      if (receipt.synced) {
        io.stdout(`SYNCED ${receipt.synced.files} files (${receipt.synced.bytes} bytes); pull changes with: flows sync ${receipt.runId}`);
        for (const link of receipt.synced.skippedLinks) {
          io.stderr(`WARNING [sync_link_skipped] ${link} points outside the synced tree and was not uploaded`);
        }
      }
    }
    if (!wait) {
      if (json) io.stdout(JSON.stringify({ ok: true, ...receipt }));
      return 0;
    }
    const run = await waitForCloudFlowRun(receipt.runId, { signal: controller.signal });
    const ok = run.status === 'completed';
    if (json) io.stdout(JSON.stringify({ ok, ...receipt, ...run }));
    else io.stdout(`${run.status.toUpperCase()} ${run.runId} completionReason: ${'completionReason' in run ? run.completionReason : 'unavailable'}`);
    return ok ? 0 : 1;
  } catch (error) {
    const code = controller.signal.aborted
      ? runId ? 'observation_aborted' : submitting ? 'admission_unknown' : 'submission_aborted'
      : error instanceof CloudFlowError ? error.code : 'cloud_run_failed';
    const message = controller.signal.aborted
      ? runId ? 'Stopped observing; the hosted run has not been cancelled.'
        : submitting
          ? 'Submission interrupted before a receipt was received. Admission is unknown; Cloud may have started the run. Do not resubmit blindly.'
          : 'Interrupted before the run was submitted; nothing was admitted. Safe to run again.'
      : (error instanceof Error ? error.message : 'Cloud run failed.') + harnessRemedy(error, harnesses);
    if (json) io.stdout(JSON.stringify({ ok: false, code, message, ...(runId ? { runId } : {}) }));
    else io.stderr(`${code}: ${message}${runId ? ` (run ${runId})` : ''}`);
    return error instanceof CloudFlowError
      && (['configuration', 'unsupported_source', 'invalid_input', 'unsupported_storage_backend', 'sync_too_large', 'sync_unsupported',
        'integration_not_connected'].includes(error.code)
        || (runId === undefined && error.code === 'http_error' && [401, 403].includes(error.status ?? 0))) ? 2 : 1;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}
