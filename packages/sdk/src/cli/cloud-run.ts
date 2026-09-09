import { CloudFlowError } from '../cloud-http.js';
import { runInCloud, waitForCloudFlowRun } from '../cloud-run.js';
import type { CliIo } from '../cli.js';

/** Presentation only: the central CLI parser owns argv; the SDK owns the lifecycle. */
export async function runCloudCli(
  { value: path, json, wait }: { value: string; json: boolean; wait: boolean },
  io: CliIo,
): Promise<0 | 1 | 2> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let runId: string | undefined;
  try {
    const receipt = await runInCloud({ path }, { signal: controller.signal });
    runId = receipt.runId;
    if (!json) {
      io.stdout(`ACCEPTED ${receipt.runId} (${receipt.status})`);
      io.stdout(receipt.apiUrl);
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
    const code = controller.signal.aborted ? (runId ? 'observation_aborted' : 'admission_unknown')
      : error instanceof CloudFlowError ? error.code : 'cloud_run_failed';
    const message = controller.signal.aborted
      ? runId ? 'Stopped observing; the hosted run has not been cancelled.'
        : 'Submission interrupted before a receipt was received. Admission is unknown; Cloud may have started the run. Do not resubmit blindly.'
      : error instanceof Error ? error.message : 'Cloud run failed.';
    if (json) io.stdout(JSON.stringify({ ok: false, code, message, ...(runId ? { runId } : {}) }));
    else io.stderr(`${code}: ${message}${runId ? ` (run ${runId})` : ''}`);
    return error instanceof CloudFlowError
      && (['configuration', 'unsupported_source', 'invalid_input'].includes(error.code)
        || (runId === undefined && error.code === 'http_error' && [401, 403].includes(error.status ?? 0))) ? 2 : 1;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}
