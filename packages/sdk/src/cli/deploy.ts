import { join } from 'node:path';
import type { CliIo } from '../cli.js';
import { BundleFailure, bucketDirectory, copyBundle, exists, parseDigestReference,
  verifyDigest, writableBucket } from '../bundle-transport.js';
import { checkRunnableBundle } from './bundle-preflight.js';

export interface DeployArgs { command: 'deploy'; value: string; to: string }
export function parseDeployArgs(args: readonly string[]): DeployArgs | undefined {
  let value: string | undefined;
  let to: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--to') {
      if (to !== undefined || !args[i + 1] || args[i + 1]!.startsWith('-')) return undefined;
      to = args[++i];
    } else if (arg.startsWith('-') || value !== undefined) return undefined;
    else value = arg;
  }
  return value && to && parseDigestReference(value) ? { command: 'deploy', value, to } : undefined;
}
export async function runDeploy(args: DeployArgs, io: CliIo): Promise<0 | 1 | 2> {
  let started = false;
  try {
    const ref = parseDigestReference(args.value);
    if (!ref) throw new BundleFailure('bundle_missing_locally', 'Expected <flow>@sha256:<64 lowercase hex characters>.');
    const source = join(process.cwd(), 'dist', 'flows', args.value);
    if (!await exists(source)) throw new BundleFailure('bundle_missing_locally', `Build ${args.value} locally first.`);
    await verifyDigest(source, ref.digest);
    const checked = await checkRunnableBundle(source, ref.name);
    if (!checked.report.ok) {
      for (const diagnostic of checked.report.diagnostics) io.stderr(`${diagnostic.severity.toUpperCase()} [${diagnostic.kind}] ${diagnostic.message}`);
      return 2;
    }
    const target = bucketDirectory(args.to, ref);
    if (await exists(target)) {
      await verifyDigest(target, ref.digest);
      io.stderr(`deploy_noop: ${args.value}`);
      return 0;
    }
    await writableBucket(target);
    started = true;
    const copied = await copyBundle(source, target, ref.digest);
    if (!copied) io.stderr(`deploy_noop: ${args.value}`);
    io.stdout(`DEPLOYED ${args.value} ${args.to}`);
    return 0;
  } catch (error) {
    const kind = started ? 'deploy_partial' : error instanceof BundleFailure ? error.kind : 'bucket_unreachable';
    io.stderr(`${started ? 'FAILED' : 'REFUSED'} [${kind}] ${error instanceof Error ? error.message : String(error)}`);
    return started ? 1 : 2;
  }
}
