import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const spawnCalls: Array<{ cli: string; args: string[]; options: Record<string, unknown> }> = [];

vi.mock('node:child_process', () => ({
  spawn: (cli: string, args: string[], options: Record<string, unknown>) => {
    spawnCalls.push({ cli, args, options });
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdin = new EventEmitter() as EventEmitter & Record<string, unknown>;
    stdin.end = () => {};
    stdin.write = (_: unknown, cb: (e?: Error) => void) => { cb(); return true; };
    stdin.destroyed = false;
    stdin.writableEnded = false;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => true;
    setImmediate(() => {
      const payload = cli === 'claude'
        ? JSON.stringify({ result: '', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 })
        : JSON.stringify({ type: 'usage', usage: { input_tokens: 1, output_tokens: 1, total_cost_usd: 0 } });
      stdout.emit('data', Buffer.from(payload));
      child.emit('close', 0);
    });
    return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
  },
}));

// Import after the mock is registered so the module picks up the mocked spawn.
import { runAgentCli } from '../src/worker-cli.js';

describe('runAgentCli — cwd propagation (flows#357)', () => {
  it('threads explicit cwd into spawn options', async () => {
    spawnCalls.length = 0;
    await runAgentCli('claude', 'hello', undefined, 'claude-sonnet-4-6',
      undefined, undefined, 'agent', undefined, '/tmp/probe-worktree');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.options.cwd).toBe('/tmp/probe-worktree');
  });

  it('omits cwd when not provided (inherits parent cwd)', async () => {
    spawnCalls.length = 0;
    await runAgentCli('claude', 'hello', undefined, 'claude-sonnet-4-6');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.options.cwd).toBeUndefined();
  });
});
