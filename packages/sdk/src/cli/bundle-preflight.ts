import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BundleFailure } from '../bundle-transport.js';
import { compileSpec, kernelToAuthoring } from '../compile.js';
import { checkAuthoredFlow, type CheckExecution } from './check.js';

/** Refuse unsupported execution: a TS declaration is not its body, and
 * daemon-relative assets must never resolve in an unrelated checkout. */
export async function checkRunnableBundle(directory: string, name: string): Promise<CheckExecution> {
  const metadata = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as { path: string }[];
  const flow = compileSpec(kernelToAuthoring(JSON.parse(await readFile(join(directory, 'spec.canonical.json'), 'utf8'))));
  if (flow.name !== name) throw new BundleFailure('bundle_signature_invalid', 'Bundle name does not match the requested flow.');
  if (metadata.kind !== 'declarative' || flow.steps.some(step => step.type !== 'deterministic'
      || step.requirements !== undefined) || (flow.triggers?.length ?? 0) > 0
      || manifest.some(entry => entry.path.startsWith('assets/'))) {
    throw new BundleFailure('bundle_unsupported',
      'This slice runs declarative deterministic bundles without assets, placement requirements, or triggers.');
  }
  // Keep existing fail-closed environment checks before transport/journal.
  // Splitting static and environment checks is follow-up.
  return checkAuthoredFlow(flow, join(directory, 'spec.canonical.json'));
}
