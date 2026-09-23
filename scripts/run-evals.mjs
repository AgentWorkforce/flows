#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isWithin, runEvalSuite } from './eval-suite.mjs';

export function parseArgs(argv) {
  const options = { rootDir: process.cwd(), allowDirty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--allow-dirty') {
      options.allowDirty = true;
      continue;
    }
    if (!['--suite', '--output', '--implementation', '--repeat', '--root'].includes(arg)) {
      throw new Error(`unknown option: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.length === 0) throw new Error(`missing value for ${arg}`);
    index += 1;
    if (arg === '--suite') options.suitePath = value;
    if (arg === '--output') options.output = value;
    if (arg === '--implementation') options.implementation = value;
    if (arg === '--repeat') options.repetitions = Number(value);
    if (arg === '--root') options.rootDir = value;
  }
  if (!options.suitePath) throw new Error('missing required option --suite');
  if (
    options.repetitions !== undefined &&
    (!Number.isInteger(options.repetitions) || options.repetitions < 1)
  ) {
    throw new Error('--repeat must be a positive integer');
  }
  return options;
}

export function reportExitCode(report) {
  return report.summary.publicationStatus === 'eligible' ? 0 : 1;
}

export function validateOutputPath(rootDir, output) {
  if (output && isWithin(resolve(rootDir), resolve(rootDir, output))) {
    throw new Error('report output must be outside the source tree so it cannot dirty later runs');
  }
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    validateOutputPath(options.rootDir, options.output);
    const report = runEvalSuite(options);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) writeFileSync(resolve(options.rootDir, options.output), json);
    else process.stdout.write(json);
    process.stderr.write(
      `${report.suite.id}: ${report.summary.passedTrials}/${report.summary.totalTrials} trials passed; ` +
        `publication ${report.summary.publicationStatus}\n`,
    );
    process.exitCode = reportExitCode(report);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
