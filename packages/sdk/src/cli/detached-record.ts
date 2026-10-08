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
  /** The daemon admitted the run: the only signal that makes a detach succeed. */
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
      // Never admitted means the parent reports this execution as-is.
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
      // Admission is explicit. A failure report can name the requested run
      // (e.g. resume's pre-admission source check) without having admitted it.
      execution = result;
      publish();
    },
  };
}
