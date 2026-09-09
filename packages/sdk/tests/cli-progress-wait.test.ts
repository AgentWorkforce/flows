import { afterEach, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { emptyReport, runFlow, resumeFlow, type RunLifecycleOptions } from '../src/cli/run.js';
vi.mock('../src/cli/run.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/cli/run.js')>(),
  runFlow: vi.fn(), resumeFlow: vi.fn(),
}));
afterEach(() => { vi.restoreAllMocks(); });
it.each(['run', 'resume'])('%s starts the wait clock on its first observed lease', async command => {
  const clock = vi.spyOn(performance, 'now');
  const output: string[] = [];
  const execute = async (_value: string, _data: string, options?: RunLifecycleOptions) => {
    const progress = { runId: 'run', stepId: 'agent', stepType: 'agent' as const, leaseDeadlineMs: Date.now() + 30_000 };
    clock.mockReturnValue(1000);
    options?.onWait?.(progress);
    clock.mockReturnValue(3500);
    options?.onWait?.(progress);
    return { exitCode: 0, report: emptyReport('run') };
  };
  vi.mocked(runFlow).mockImplementation(execute);
  vi.mocked(resumeFlow).mockImplementation(execute);
  await runCli([command, command === 'run' ? 'example.flow.yaml' : 'run'], {
    stdout: () => {}, stderr: line => { output.push(line); },
  });
  expect(output.filter(line => line.startsWith('↻'))).toEqual([
    '↻ agent (agent) [agent: running] 0.00s', '↻ agent (agent) [agent: running] 2.50s',
  ]);
});
