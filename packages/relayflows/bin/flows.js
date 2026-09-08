#!/usr/bin/env node
import { runCli } from '@relayflows/sdk';

process.exitCode = await runCli(process.argv.slice(2));
