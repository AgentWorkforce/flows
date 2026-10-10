import { readFile, writeFile } from 'node:fs/promises';
import type { CliIo } from '../cli.js';
import { CloudFlowError } from '../cloud-http.js';
import {
  evaluateFlow, FlowEvalError, loadFlowEvalSuite,
  type FlowEvalExecutor, type FlowEvalReport,
} from '../flow-eval.js';
import { cloudFlowEvalExecutor } from '../flow-eval-cloud.js';
import { localFlowEvalExecutor } from '../flow-eval-local.js';

export interface EvalArgs {
  command: 'eval';
  value: string;
  cases: string;
  json: boolean;
  cloud: boolean;
  dataDir: string;
  localAgent: boolean;
  concurrency?: number;
  report?: string;
  baseline?: string;
  expectVersion?: string;
}

export function parseEvalArgs(args: readonly string[]): EvalArgs | undefined {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];
  const valued = ['--cases', '--data-dir', '--concurrency', '--report', '--baseline', '--expect-version'];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--json' || argument === '--cloud' || argument === '--local-agent') {
      if (flags.has(argument)) return undefined;
      flags.add(argument);
    } else if (valued.includes(argument)) {
      const value = args[++index];
      if (value === undefined || value.length === 0 || value.startsWith('-') || values.has(argument)) return undefined;
      values.set(argument, value);
    } else if (argument.startsWith('-')) {
      return undefined;
    } else {
      positionals.push(argument);
    }
  }
  const cases = values.get('--cases');
  if (positionals.length !== 1 || cases === undefined) return undefined;
  // Local-only options have no meaning against Cloud; refuse rather than ignore.
  if (flags.has('--cloud') && (flags.has('--local-agent') || values.has('--data-dir'))) return undefined;
  let concurrency: number | undefined;
  if (values.has('--concurrency')) {
    concurrency = Number(values.get('--concurrency'));
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) return undefined;
  }
  return {
    command: 'eval',
    value: positionals[0]!,
    cases,
    json: flags.has('--json'),
    cloud: flags.has('--cloud'),
    localAgent: flags.has('--local-agent'),
    dataDir: values.get('--data-dir') ?? '.relayflowd',
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(values.has('--report') ? { report: values.get('--report')! } : {}),
    ...(values.has('--baseline') ? { baseline: values.get('--baseline')! } : {}),
    ...(values.has('--expect-version') ? { expectVersion: values.get('--expect-version')! } : {}),
  };
}

/**
 * `flows eval`: re-execute the flow against every case and print the report.
 * Exit 0 when the gate passes, 1 when it fails, 2 when the evaluation was refused.
 */
export async function runEvalCli(
  args: EvalArgs,
  io: CliIo,
  signal: AbortSignal,
  executor?: FlowEvalExecutor,
): Promise<0 | 1 | 2> {
  let report: FlowEvalReport;
  try {
    const suite = await loadFlowEvalSuite(args.cases);
    let baseline: unknown;
    if (args.baseline !== undefined) {
      try {
        baseline = JSON.parse(await readFile(args.baseline, 'utf8'));
      } catch {
        throw new FlowEvalError('invalid_baseline', `Baseline report "${args.baseline}" is not readable JSON.`);
      }
    }
    report = await evaluateFlow({
      flow: { path: args.value },
      suite,
      executor: executor ?? (args.cloud
        ? cloudFlowEvalExecutor({ signal })
        : localFlowEvalExecutor({ dataDir: args.dataDir, localAgent: args.localAgent })),
      executorName: executor !== undefined ? 'custom' : args.cloud ? 'cloud' : 'local',
      signal,
      ...(args.concurrency === undefined ? {} : { concurrency: args.concurrency }),
      ...(args.expectVersion === undefined ? {} : { expectVersion: args.expectVersion }),
      ...(baseline === undefined ? {} : { baseline }),
    });
  } catch (error) {
    if (signal.aborted) {
      io.stderr('CANCELED evaluation interrupted; runs already started are not stopped by this command.');
      return 2;
    }
    const kind = error instanceof FlowEvalError || error instanceof CloudFlowError ? error.code : 'eval_failed';
    const message = error instanceof Error ? error.message : String(error);
    return refuse(args, io, kind, message);
  }
  if (args.report !== undefined) {
    try {
      await writeFile(args.report, `${JSON.stringify(report, null, 2)}\n`);
    } catch {
      return refuse(args, io, 'report_unwritable', `Could not write the report to "${args.report}".`);
    }
  }
  if (args.json) {
    io.stdout(JSON.stringify(report));
  } else {
    for (const result of report.cases) {
      const cost = result.costUsd === null ? 'cost=?' : `cost=$${result.costUsd}`;
      io.stdout(`${result.outcome.toUpperCase()} ${result.id} latency=${result.latencyMs}ms ${cost}`
        + (result.runId === undefined ? '' : ` run=${result.runId}`));
      for (const failure of result.failures) io.stdout(`  - ${failure}`);
    }
    const { summary } = report;
    io.stdout(`${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.errored} errored; `
      + `p50=${summary.latencyMs.p50}ms p95=${summary.latencyMs.p95}ms `
      + `cost=${summary.totalCostUsd === null ? '?' : `$${summary.totalCostUsd}`}`);
    io.stdout(`flow ${report.flow.version} suite ${report.suite.sha256}`);
    io.stdout(report.gate.pass ? 'GATE PASS' : `GATE FAIL: ${report.gate.reasons.join('; ')}`);
  }
  return report.gate.pass ? 0 : 1;
}

function refuse(args: EvalArgs, io: CliIo, kind: string, message: string): 2 {
  if (args.json) io.stdout(JSON.stringify({ ok: false, diagnostics: [{ severity: 'refusal', kind, message }] }));
  else io.stderr(`REFUSED [${kind}] ${message}`);
  return 2;
}
