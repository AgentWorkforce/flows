import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readSync, fstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CliIo } from '../cli.js';
import { LOCAL_AGENT_ENV_FD } from '../local-agent-environment.js';
import { shellWord } from '../shell-word.js';
import { DETACH_RECORD_ENV, readDetachedRecord } from './detached-record.js';
import type { RunExecution } from './run.js';

// Preflight may compile authored code or fetch a bundle; it runs only in the child.
export const DETACHED_START_TIMEOUT_MS = 60_000;
// Observation is optional. Never wait for it for the duration of the run.
export const DETACHED_OBSERVER_GRACE_MS = 2_000;
const POLL_MS = 50;

export interface DetachedHandle {
  detached: true;
  runId: string;
  pid: number;
  logPath: string;
  recordPath: string;
  observerUrl?: string;
  follow: string;
  notice: string;
}

export type DetachedResult = { handle: DetachedHandle } | { execution: RunExecution };

export function detachedArgv(args: readonly string[]): string[] {
  return args.filter(argument => argument !== '--detach');
}

export async function startDetachedRun(
  args: readonly string[],
  options: { command: 'run' | 'resume'; dataDir: string; noObserverLink: boolean; selfCommand?: readonly string[] },
): Promise<DetachedResult> {
  const failure = (message: string, refusal = false): DetachedResult => ({ execution: {
    exitCode: refusal ? 2 : 1,
    report: { ok: false, command: options.command, resolutions: [], diagnostics: [refusal
      ? { severity: 'refusal', kind: 'invalid_invocation', message }
      : { severity: 'failure', kind: 'protocol_error', message }] },
  } });
  // This descriptor is deliberately not inherited. Silently losing its provider
  // credentials would admit a run that cannot execute its steps.
  if (process.env[LOCAL_AGENT_ENV_FD] !== undefined) {
    return failure(`detach_environment_fd_unsupported: --detach cannot forward ${LOCAL_AGENT_ENV_FD}; use foreground execution.`, true);
  }
  let logPath: string | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const directory = join(resolve(options.dataDir), 'detached');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const handleDir = mkdtempSync(join(directory, 'run-'));
    logPath = join(handleDir, 'run.log');
    const recordPath = join(handleDir, 'record.json');
    const log = openSync(logPath, 'a', 0o600);
    let spawnError: Error | undefined;
    let exited = false;
    try {
      const [executable, ...prefix] = options.selfCommand ?? defaultSelfCommand();
      child = spawn(executable!, [...prefix, ...detachedArgv(args)], {
        detached: true, stdio: ['ignore', log, log], cwd: process.cwd(),
        env: { ...process.env, [DETACH_RECORD_ENV]: recordPath },
      });
      child.once('error', error => { spawnError = error; });
      child.once('exit', () => { exited = true; });
      child.unref();
    } finally { closeSync(log); }
    const deadline = Date.now() + DETACHED_START_TIMEOUT_MS;
    let observerDeadline: number | undefined;
    for (;;) {
      const record = readDetachedRecord(recordPath);
      if (record?.phase === 'refused') return { execution: record.execution! };
      if (record?.runId !== undefined) {
        observerDeadline ??= Date.now() + DETACHED_OBSERVER_GRACE_MS;
        if (options.noObserverLink || record.observerUrl !== undefined
          || exited || Date.now() >= observerDeadline) {
          return { handle: {
            detached: true, runId: record.runId, pid: record.pid, logPath, recordPath,
            ...(record.observerUrl === undefined ? {} : { observerUrl: record.observerUrl }),
            follow: `flows status ${shellWord(record.runId)} --data-dir ${shellWord(resolve(options.dataDir))}`,
            notice: 'Started in background; the run may later fail or park. Check status and the log for any park remedy.',
          } };
        }
      } else if (spawnError !== undefined || exited) {
        return failure(`detached_start_failed: ${spawnError?.message ?? 'child exited before publishing a run id'}. Log: ${logPath}\n${logTail(logPath)}`);
      } else if (Date.now() >= deadline) {
        // Signal only this child, never a pre-existing daemon. The agent reaper
        // owns provider-tree cleanup. A timeout is not a run cancellation.
        child.kill('SIGTERM');
        return failure(`detached_start_timeout: no receipt within ${DETACHED_START_TIMEOUT_MS}ms; sent SIGTERM to child. Inspect ${logPath} before retrying; a journal may already exist.\n${logTail(logPath)}`);
      }
      await sleep(POLL_MS);
    }
  } catch (error) {
    child?.kill('SIGTERM');
    return failure(`detached_start_failed: ${error instanceof Error ? error.message : String(error)}${logPath === undefined ? '' : `. Log: ${logPath}`}`);
  }
}

/**
 * cli-watch.ts's re-exec precedent supports both source and built entries. A
 * compiled executable is its own entry: its module path is virtual and would
 * reach the CLI as an extra positional, so it passes `selfCommand` instead.
 */
function defaultSelfCommand(): string[] {
  const entry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../cli.ts' : '../cli.js', import.meta.url));
  return [process.execPath, ...process.execArgv, entry];
}

export function emitDetachedHandle(handle: DetachedHandle, json: boolean, io: CliIo): void {
  if (json) { io.stdout(JSON.stringify(handle)); return; }
  io.stdout(`DETACHED ${handle.runId}  pid ${handle.pid}`);
  io.stdout(`Log: ${handle.logPath}`);
  io.stdout(`Receipt: ${handle.recordPath}`);
  if (handle.observerUrl !== undefined) io.stdout(`Observer: ${handle.observerUrl}`);
  io.stdout(`Follow: ${handle.follow}`);
  io.stdout(handle.notice);
}

function logTail(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 4096));
    const count = readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return buffer.subarray(0, count).toString('utf8');
  } finally { closeSync(fd); }
}
