import { expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { runAgentCli } from '../src/worker-cli.js';
import { runWrapperSession } from '../src/wrapper-session.js';
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn(),
}));
it('fails closed before spawning a lease-bound process on Windows', async () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const signal = new AbortController().signal;
  try {
    await expect(runAgentCli('claude', 'hello', undefined, undefined, undefined, signal)).rejects.toThrow('Windows is unsupported');
    await expect(runWrapperSession('wrapper', 'hello', undefined, undefined, {}, {}, signal)).rejects.toThrow('Windows is unsupported');
    expect(spawn).not.toHaveBeenCalled();
  } finally { platform.mockRestore(); }
});
