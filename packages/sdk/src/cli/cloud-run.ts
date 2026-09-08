import { CloudFlowError } from '../cloud-http.js';
import { runInCloud, waitForCloudFlowRun } from '../cloud-run.js';
import type { CliIo } from '../cli.js';

/** Only argv and presentation live here. The SDK owns submission and waiting. */
export async function runCloudCli(args: readonly string[], io: CliIo): Promise<0 | 1 | 2> {
  const json = args.includes('--json');
  let wait = false;
  let cloud = false;
  let sawJson = false;
  let path: string | undefined;
  const invalid = (): 2 => {
    const message = 'Usage: flows run --cloud [--json] [--wait] <flow.yaml|spec.json>';
    if (json) io.stdout(JSON.stringify({ ok: false, code: 'invalid_invocation', message }));
    else io.stderr(message);
    return 2;
  };
  if (args[0] !== 'run') return invalid();
  for (const arg of args.slice(1)) {
    if (arg === '--cloud' && !cloud) cloud = true;
    else if (arg === '--json' && !sawJson) sawJson = true;
    else if (arg === '--wait' && !wait) wait = true;
    else if (!arg.startsWith('-') && path === undefined) path = arg;
    else return invalid();
  }
  if (!cloud || path === undefined) return invalid();
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let runId: string | undefined;
  try {
    const receipt = await runInCloud({ path }, { signal: controller.signal });
    runId = receipt.runId;
    if (!json) io.stdout(`ACCEPTED ${receipt.runId} (${receipt.status})\n${receipt.apiUrl}`);
    if (!wait) {
      if (json) io.stdout(JSON.stringify({ ok: true, ...receipt }));
      return 0;
    }
    const run = await waitForCloudFlowRun(receipt.runId, { signal: controller.signal });
    const ok = run.status === 'completed';
    if (json) io.stdout(JSON.stringify({ ok, ...receipt, ...run }));
    else io.stdout(`${run.status.toUpperCase()} ${run.runId}`);
    return ok ? 0 : 1;
  } catch (error) {
    const code = controller.signal.aborted ? 'observation_aborted'
      : error instanceof CloudFlowError ? error.code : 'cloud_run_failed';
    const message = controller.signal.aborted
      ? 'Stopped observing; the hosted run has not been cancelled.'
      : error instanceof Error ? error.message : 'Cloud run failed.';
    if (json) io.stdout(JSON.stringify({ ok: false, code, message, ...(runId ? { runId } : {}) }));
    else io.stderr(`${code}: ${message}${runId ? ` (run ${runId})` : ''}`);
    return error instanceof CloudFlowError
      && ['configuration', 'unsupported_source'].includes(error.code) ? 2 : 1;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}
