import { probeCliAsync } from './cli/cli-probe.js';
import type { CliProbeResult } from './preflight.js';

/** Commands served by the sealed authored Node payload before flow startup. */
export async function authoredNodeUtility(args: string[]): Promise<CliProbeResult | undefined> {
  if (args[0] !== '--probe-cli') return undefined;
  const [cli, model, directory, extra] = args.slice(1);
  if (!cli || !model || !directory || extra !== undefined) {
    throw new Error('authored --probe-cli requires exactly CLI, model, and directory');
  }
  return probeCliAsync(cli, directory, model);
}
