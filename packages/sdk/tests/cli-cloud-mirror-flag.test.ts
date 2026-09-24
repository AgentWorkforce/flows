import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli.js';

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: line => out.push(line), stderr: line => err.push(line) }, out, err };
}

/**
 * `--cloud-mirror` is refused wherever it would describe nothing, rather than
 * being accepted and ignored. A flag that silently no-ops is worse than one
 * that is rejected: it reads as a request that was honoured.
 */
describe('flows --cloud-mirror', () => {
  it('is refused on `check`, which starts no run to mirror', async () => {
    const { io } = capture();
    expect(await runCli(['check', '--cloud-mirror', 'flow.yaml'], io)).toBe(2);
  });

  it('is refused with --cloud, which IS the hosted run', async () => {
    const { io } = capture();
    expect(await runCli(['run', '--cloud', '--cloud-mirror', 'flow.yaml'], io)).toBe(2);
  });

  it('is refused twice over, like every other flag here', async () => {
    const { io } = capture();
    expect(await runCli(['run', '--cloud-mirror', '--cloud-mirror', 'flow.yaml'], io)).toBe(2);
  });

  it('is listed in the usage for the verbs that accept it', async () => {
    const { io, out } = capture();
    await runCli(['--help'], io);
    const usage = out.join('\n');
    expect(usage).toContain('flows run [--json] [--no-spawn] [--no-observer-link] [--cloud-mirror]');
    expect(usage).toContain('flows resume [--allow-human-influenced] [--json] [--no-spawn] [--no-observer-link] [--cloud-mirror]');
  });
});
