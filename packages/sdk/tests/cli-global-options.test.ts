import { describe, expect, it } from 'vitest';
import { CLI_GLOBAL_OPTIONS } from '../src/cli-commands.js';
import { runCli, type CliIo } from '../src/cli.js';

function capture(): { io: CliIo; out: string[] } {
  const out: string[] = [];
  return { io: { stdout: line => out.push(line), stderr: () => undefined }, out };
}

describe('CLI_GLOBAL_OPTIONS', () => {
  it('declares exactly the root flags runCli handles, each spelling', async () => {
    const spellings = CLI_GLOBAL_OPTIONS.flatMap(option => option.flags.split(', '));
    expect(spellings).toEqual(['-h', '--help', '-V', '--version']);
    for (const flag of spellings) {
      const { io, out } = capture();
      expect(await runCli([flag], io, { version: '9.9.9' })).toBe(0);
      if (flag === '-V' || flag === '--version') expect(out).toEqual(['9.9.9']);
      else expect(out.join('\n')).toMatch(/^Usage/m);
    }
  });
  it('accepts a global option only as the sole argument', async () => {
    const { io } = capture();
    expect(await runCli(['--version', 'extra'], io)).not.toBe(0);
  });
});
