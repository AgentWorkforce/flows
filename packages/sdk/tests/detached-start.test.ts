import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { spawn, type SpawnOptions } from 'node:child_process';
import { startDetachedRun, DETACHED_START_TIMEOUT_MS } from '../src/cli/detached-run.js';
import { DETACH_RECORD_ENV } from '../src/cli/detached-record.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
// Move the simulated wall clock at each poll, without a real minute-long test.
vi.mock('node:timers/promises', () => ({ setTimeout: async (ms: number) => { vi.setSystemTime(Date.now() + ms); } }));
let root: string;
let child: EventEmitter & { kill: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'detach-start-'));
  vi.useFakeTimers({ toFake: ['Date'] });
  child = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() });
  vi.mocked(spawn).mockReset();
});
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });
const options = () => ({ command: 'run' as const, dataDir: root, noObserverLink: true });

it('reports an early child exit with the captured log tail', async () => {
  vi.mocked(spawn).mockImplementation((_exe, _args, opts) => {
    const log = (opts as SpawnOptions).stdio as number[];
    writeFileSync(log[2]!, 'fixture boot failure');
    queueMicrotask(() => child.emit('exit', 1, null));
    return child as never;
  });
  const result = await startDetachedRun(['run', '--detach', 'flow.yaml'], options());
  expect(result).toMatchObject({ execution: { exitCode: 1, report: {
    diagnostics: [{ message: expect.stringContaining('fixture boot failure') }],
  } } });
  expect(child.unref).toHaveBeenCalledOnce();
});

it('bounds startup and signals only the spawned child on timeout', async () => {
  vi.mocked(spawn).mockReturnValue(child as never);
  const started = Date.now();
  const result = await startDetachedRun(['run', '--detach', 'flow.yaml'], options());
  expect(Date.now() - started).toBe(DETACHED_START_TIMEOUT_MS);
  expect(child.kill).toHaveBeenCalledOnce();
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  expect(result).toMatchObject({ execution: { exitCode: 1, report: {
    diagnostics: [{ message: expect.stringContaining('detached_start_timeout') }],
  } } });
});

it('re-execs a compiled executable through selfCommand without a virtual entry argument', async () => {
  vi.mocked(spawn).mockImplementation((_exe, _args, opts) => {
    writeFileSync((opts as SpawnOptions).env![DETACH_RECORD_ENV]!, JSON.stringify({ phase: 'started', pid: 9, runId: 'RUN' }));
    return child as never;
  });
  const argv = ['run', 'flow.yaml', '--json', '--detach'];
  expect(await startDetachedRun(argv, { ...options(), selfCommand: ['/opt/flows'] })).toMatchObject({ handle: { runId: 'RUN' } });
  const [exe, args] = vi.mocked(spawn).mock.calls[0]!;
  expect(exe).toBe('/opt/flows');
  expect(args).toEqual(['run', 'flow.yaml', '--json']);
});

it('returns an unadmitted child execution unchanged', async () => {
  const execution = { exitCode: 1, report: { ok: false, command: 'resume', runId: 'OLD', resolutions: [], diagnostics: [] } };
  vi.mocked(spawn).mockImplementation((_exe, _args, opts) => {
    writeFileSync((opts as SpawnOptions).env![DETACH_RECORD_ENV]!, JSON.stringify({ phase: 'refused', pid: 9, execution }));
    return child as never;
  });
  expect(await startDetachedRun(['resume', 'OLD', '--detach'], { ...options(), command: 'resume' })).toEqual({ execution });
});

it('re-execs with private stdio, original argv and the current working directory', async () => {
  vi.mocked(spawn).mockImplementation((_exe, _args, opts) => {
    const record = (opts as SpawnOptions).env![DETACH_RECORD_ENV]!;
    writeFileSync(record, JSON.stringify({ phase: 'started', pid: 123, runId: 'RUN' }));
    return child as never;
  });
  const argv = ['run', 'space.flow.ts', '--input', '{"a":1}', '--cloud-mirror', '--detach'];
  const result = await startDetachedRun(argv, options());
  expect(result).toMatchObject({ handle: { runId: 'RUN', pid: 123 } });
  const [exe, args, opts] = vi.mocked(spawn).mock.calls[0]!;
  expect(exe).toBe(process.execPath);
  expect(args).toEqual([...process.execArgv, expect.stringMatching(/\/cli\.ts$/), ...argv.slice(0, -1)]);
  expect(opts).toMatchObject({ detached: true, cwd: process.cwd(), stdio: ['ignore', expect.any(Number), expect.any(Number)] });
  expect(child.kill).not.toHaveBeenCalled();
});
