#!/usr/bin/env node

import { runCli } from './cli.js';

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
