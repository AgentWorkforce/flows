import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli.js';

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }, stdout, stderr };
}

/**
 * `flows answer` argument shape. Every refusal here is a parse refusal: no
 * daemon is contacted, so the only exit is 2 with the usage text.
 */
describe('flows answer invocation', () => {
  it.each([
    ['no arguments', ['answer']],
    ['missing the answer word', ['answer', 'run-1', 'human-1']],
    ['an ambiguous word', ['answer', 'run-1', 'human-1', 'maybe']],
    ['a fourth positional', ['answer', 'run-1', 'human-1', 'yes', 'extra']],
    ['--note without text', ['answer', 'run-1', 'human-1', 'yes', '--note']],
    ['--note followed by a flag', ['answer', 'run-1', 'human-1', 'yes', '--note', '--json']],
    ['--data-dir without a path', ['answer', 'run-1', 'human-1', 'yes', '--data-dir']],
    ['--by without an identity', ['answer', 'run-1', 'human-1', 'yes', '--by']],
    ['--by followed by a flag', ['answer', 'run-1', 'human-1', 'yes', '--by', '--json']],
    ['a repeated --json', ['answer', '--json', '--json', 'run-1', 'human-1', 'yes']],
    ['worker flags that mean nothing here', ['answer', 'run-1', 'human-1', 'yes', '--local-agent']],
    ['--allow-human-influenced', ['answer', 'run-1', 'human-1', 'yes', '--allow-human-influenced']],
  ])('refuses %s with the usage text', async (_name, args) => {
    const output = capture();
    expect(await runCli(args, output.io)).toBe(2);
    expect(output.stderr.join('\n')).toContain('[invalid_invocation]');
    expect(output.stderr.join('\n')).toContain('flows answer [--json] [--no-spawn] [--data-dir <dir>] [--note <text>] [--by <identity>] <run-id> <wait-id> <yes|no>');
  });

  it('refuses a wait id that is not human-<n> before contacting any daemon', async () => {
    const output = capture();
    expect(await runCli(['answer', '--no-spawn', '--data-dir', '/nonexistent/data', 'run-1', 'approval', 'yes'], output.io)).toBe(2);
    expect(output.stderr.join('\n')).toContain('[human_wait_unknown] "approval" is not an f.human wait id');
    expect(output.stdout).toEqual([]);
  });

  it('accepts true/false as yes/no and reaches the daemon seam', async () => {
    // With `--no-spawn` and no daemon, the parse succeeded and the attach
    // refused: that is the first thing past argument validation.
    for (const word of ['true', 'false', 'yes', 'no']) {
      const output = capture();
      expect(await runCli(['answer', '--no-spawn', '--data-dir', '/nonexistent/data', 'run-1', 'human-1', word], output.io)).toBe(2);
      expect(output.stderr.join('\n')).not.toContain('[invalid_invocation]');
      expect(output.stderr.join('\n')).toMatch(/\[(daemon_unreachable|relayflowd_not_found)]/);
    }
  });

  it('lists the command in --help', async () => {
    const output = capture();
    expect(await runCli(['--help'], output.io)).toBe(0);
    expect(output.stdout.join('\n')).toContain('flows answer');
  });
});
