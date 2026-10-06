import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { RunExecution } from './run.js';

export const DETACH_RECORD_ENV = 'FLOWS_DETACH_RECORD';

/** A receipt/index, never run state: the journal remains authoritative. */
export interface DetachedRecord {
  phase: 'started' | 'finished' | 'refused';
  pid: number;
  runId?: string;
  observerUrl?: string;
  execution?: RunExecution;
}

export function readDetachedRecord(path: string): DetachedRecord | undefined {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const record = JSON.parse(text) as DetachedRecord;
  if (!['started', 'finished', 'refused'].includes(record.phase)
    || !Number.isSafeInteger(record.pid) || record.pid <= 0
    || (record.phase === 'started' && typeof record.runId !== 'string')
    || (record.phase !== 'started' && record.execution === undefined)) {
    throw new Error('Invalid detached receipt');
  }
  return record;
}

export interface DetachedReceipt {
  started(run: { runId: string }): void;
  observerUrl(url: string): void;
  finished(execution: RunExecution): void;
}

/** Only the standalone child consumes this marker, before authored code loads. */
export function takeDetachedReceipt(env: NodeJS.ProcessEnv = process.env): DetachedReceipt | undefined {
  const path = env[DETACH_RECORD_ENV];
  delete env[DETACH_RECORD_ENV];
  if (path === undefined) return undefined;
  let runId: string | undefined;
  let observerUrl: string | undefined;
  let execution: RunExecution | undefined;
  const publish = (): void => {
    const record: DetachedRecord = {
      pid: process.pid,
      phase: execution === undefined ? 'started' : runId === undefined ? 'refused' : 'finished',
      ...(runId === undefined ? {} : { runId }),
      ...(observerUrl === undefined ? {} : { observerUrl }),
      ...(execution === undefined ? {} : { execution }),
    };
    if (runId === undefined && execution === undefined) return;
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    renameSync(temporary, path);
  };
  return {
    started(run) { runId ??= run.runId; publish(); },
    observerUrl(url) { observerUrl = url; publish(); },
    finished(result) {
      execution = result;
      // A refusal can name an existing run without having admitted a resume.
      if (result.exitCode !== 2) runId ??= result.report.rootRunId ?? result.report.runId;
      publish();
    },
  };
}
