import { join } from 'node:path';
import type { CliIo } from '../cli.js';
import { BundleFailure, bucketDirectory, copyBundle, exists, parseDigestReference,
  verifyDigest, writableBucket } from '../bundle-transport.js';
import { checkRunnableBundle } from './bundle-preflight.js';

export interface DeployArgs { command: 'deploy'; value: string; to: string; json: boolean }

/**
 * `--json` is declared on the `deploy` verb, which both forms share, so the
 * bundle form has to accept it too -- the hosted-listener parser already did,
 * and help cannot tell a reader the flag belongs to only one of them.
 */
export function parseDeployArgs(args: readonly string[]): DeployArgs | undefined {
  let value: string | undefined;
  let to: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--to') {
      if (to !== undefined || !args[i + 1] || args[i + 1]!.startsWith('-')) return undefined;
      to = args[++i];
    } else if (arg === '--json') {
      if (json) return undefined;
      json = true;
    } else if (arg.startsWith('-') || value !== undefined) return undefined;
    else value = arg;
  }
  return value && to && parseDigestReference(value) ? { command: 'deploy', value, to, json } : undefined;
}

/** One machine-readable object per outcome, or the text line it mirrors. */
function emitDeployOutcome(status: 'deployed' | 'already-present', args: DeployArgs, io: CliIo): void {
  if (args.json) io.stdout(JSON.stringify({ ok: true, bundle: args.value, to: args.to, status }));
  else io.stdout(`${status === 'deployed' ? 'DEPLOYED' : 'SKIPPED (already-present)'} ${args.value} ${args.to}`);
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
      if (args.json) {
        io.stdout(JSON.stringify({ ok: false, code: 'bundle_unrunnable', bundle: args.value, to: args.to,
          diagnostics: checked.report.diagnostics }));
      }
      return 2;
    }
    // `ok` may still carry warnings (e.g. `budget_unmetered`); report them.
    for (const diagnostic of checked.report.diagnostics) {
      if (diagnostic.severity === 'warning') io.stderr(`WARNING [${diagnostic.kind}] ${diagnostic.message}`);
    }
    const target = bucketDirectory(args.to, ref);
    if (await exists(target)) {
      await verifyDigest(target, ref.digest);
      io.stderr(`deploy_noop: ${args.value}`);
      emitDeployOutcome('already-present', args, io);
      return 0;
    }
    await writableBucket(target);
    started = true;
    const copied = await copyBundle(source, target, ref.digest);
    if (!copied) io.stderr(`deploy_noop: ${args.value}`);
    emitDeployOutcome(copied ? 'deployed' : 'already-present', args, io);
    return 0;
  } catch (error) {
    const kind = started ? 'deploy_partial' : error instanceof BundleFailure ? error.kind : 'bucket_unreachable';
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`${started ? 'FAILED' : 'REFUSED'} [${kind}] ${message}`);
    if (args.json) io.stdout(JSON.stringify({ ok: false, code: kind, message, bundle: args.value, to: args.to }));
    return started ? 1 : 2;
  }
}
