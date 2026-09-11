import { BundleFailure, fetchBundle, parseDigestReference } from '../bundle-transport.js';
import { readProjectConfig, type CheckExecution } from './check.js';
import { checkRunnableBundle } from './bundle-preflight.js';
import type { RunExecution } from './run.js';

export async function prepareDigestRun(reference: string, bucket?: string): Promise<CheckExecution | RunExecution> {
  try {
    const ref = parseDigestReference(reference)!;
    const selected = bucket ?? readProjectConfig(process.cwd()).deploy?.bucket;
    if (!selected) throw new BundleFailure('bucket_unconfigured', 'Set --bucket <uri> or deploy.bucket in flows.json.');
    const directory = await fetchBundle(ref, selected);
    const checked = await checkRunnableBundle(directory, ref.name);
    checked.report.path = reference;
    return checked;
  } catch (error) {
    const kind = error instanceof BundleFailure && (
      error.kind === 'bucket_unconfigured' || error.kind === 'bucket_unreachable'
      || error.kind === 'bundle_signature_invalid' || error.kind === 'bundle_unsupported'
    ) ? error.kind : 'bundle_unsupported';
    return { exitCode: 2, report: { ok: false, command: 'run', path: reference, resolutions: [],
      diagnostics: [{ severity: 'refusal', kind, message: error instanceof Error ? error.message : String(error) }] } };
  }
}
