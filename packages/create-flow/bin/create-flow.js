#!/usr/bin/env node
import { createFlow } from '@relayflows/sdk';

const usage = 'Usage: create-flow <directory> [--name <name>] [--template agent|deterministic] [--cli <command>] [--no-install]';
const args = process.argv.slice(2);
try {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(usage);
  } else {
    let target;
    const options = {};
    const seen = new Set();
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--no-install') {
        if (seen.has(arg)) throw new Error(usage);
        seen.add(arg);
        options.install = false;
      } else if (arg === '--name' || arg === '--cli' || arg === '--template') {
        if (seen.has(arg) || !args[i + 1] || args[i + 1].startsWith('-')) throw new Error(usage);
        seen.add(arg);
        options[arg.slice(2)] = args[++i];
      } else if (arg.startsWith('-') || target !== undefined) {
        throw new Error(usage);
      } else target = arg;
    }
    if (!target) throw new Error(usage);
    const result = await createFlow(target, options);
    console.log(`Created ${result.directory}\nNext: cd ${JSON.stringify(result.directory)}${result.installed ? '' : ' && npm install'} && npm start`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
