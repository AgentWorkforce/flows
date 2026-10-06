import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CloudFlowError, cloudFetch, cloudRunId, isCloudRecord, type CloudConnectionOptions } from './cloud-http.js';
import { cloudRunState, isCloudRunActive } from './cloud-run-record.js';
import { readCloudHumanWaitValue } from './cloud-human-wait.js';

export interface CloudAnswerOptions extends CloudConnectionOptions {
  note?: string;
  /** Exact original source, including a copy pulled with flows sync. Never executed locally. */
  source?: string;
}

export interface CloudResumeReceipt {
  runId: string;
  resumedFrom: string;
  waitId: string;
  answer: boolean;
  resumedByCloud: boolean;
}

/** Preserves partial success without claiming a failed/ambiguous resume did not start. */
export class CloudAnswerError extends Error {
  constructor(readonly answerRecorded: boolean, readonly cause: unknown) {
    super(answerRecorded
      ? 'The answer is recorded, but resume could not be confirmed. Inspect Cloud status before re-running the same answer command; admission may be unknown.'
      : 'The answer request could not be confirmed. Inspect Cloud status before retrying.');
  }
}

const route = (runId: string): string => `/api/v1/workflows/runs/${runId}`;
const get = (path: string, options: CloudConnectionOptions): Promise<unknown> =>
  cloudFetch(path, options, { method: 'GET', detail: true });
const post = (path: string, body: unknown, options: CloudConnectionOptions): Promise<unknown> =>
  cloudFetch(path, options, { method: 'POST', body: JSON.stringify(body), detail: true });

/**
 * Accepted answer route shapes are explicit: humanWait (or wait), or openWaits,
 * and an optional recorded answer { waitId, answer, note? }. Unknown/ambiguous
 * shapes refuse before writes. A closed wait is retryable only with that proof.
 */
export async function readCloudHumanWait(runId: string, options: CloudConnectionOptions = {}) {
  cloudRunId(runId);
  const body = await get(`${route(runId)}/answer`, options);
  if (!isCloudRecord(body)) throw new CloudFlowError('invalid_response', 'Cloud returned no human answer record.');
  if (body.runId !== undefined && body.runId !== runId) {
    throw new CloudFlowError('invalid_response', 'Cloud returned a human answer record for a different run.');
  }
  if (['humanWait', 'wait', 'openWaits'].filter(key => body[key] !== undefined && body[key] !== null).length > 1) {
    throw new CloudFlowError('invalid_response', 'Cloud returned competing open human wait fields.');
  }
  const candidates = 'openWaits' in body ? body.openWaits
    : [body.humanWait ?? body.wait].filter(value => value !== undefined && value !== null);
  if (!Array.isArray(candidates) || candidates.length > 1) {
    throw new CloudFlowError('invalid_response', 'Cloud must report at most one open human wait.');
  }
  const wait = readCloudHumanWaitValue(candidates[0]);
  if (candidates.length === 1 && !wait) throw new CloudFlowError('invalid_response', 'Cloud returned an invalid open human wait.');
  const recorded = body.answer;
  if (recorded !== undefined && recorded !== null
    && (!isCloudRecord(recorded) || !readCloudHumanWaitValue(recorded) || typeof recorded.answer !== 'boolean'
      || (recorded.note !== undefined && typeof recorded.note !== 'string'))) {
    throw new CloudFlowError('invalid_response', 'Cloud returned an invalid recorded human answer.');
  }
  return { wait, recorded: isCloudRecord(recorded)
    ? { waitId: recorded.waitId as string, answer: recorded.answer as boolean, note: recorded.note as string | undefined }
    : undefined };
}

/** Build from admitted bytes and authority, never re-import hosted code or resend inputs. */
async function resumeBody(record: Record<string, unknown>, runId: string, source?: string) {
  // A resume without the original tree/plugins is a different execution. Until
  // Cloud exposes a complete restorable contract, refuse their presence.
  if (['s3CodeKey', 'codeKey', 'syncCode', 'synced'].some(key => record[key] !== undefined && record[key] !== null && record[key] !== false)) {
    throw new CloudFlowError('unsupported_source', 'Cannot resume a run with synced code: Cloud must restore its original working tree.');
  }
  const authority = record.relayflowV2Authority;
  if (!isCloudRecord(authority) || !isCloudRecord(authority.source)
    || typeof authority.source.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(authority.source.sha256)) {
    throw new CloudFlowError('unsupported_source', 'Cloud run lacks source.sha256 authority; cannot verify --source bytes.');
  }
  for (const value of [record.extensions, authority.extensions]) {
    if (value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)) {
      throw new CloudFlowError('unsupported_source', 'Cannot resume a run with extensions: Cloud must expose their original submissions.');
    }
  }
  let workflow = record.workflow;
  if (source !== undefined) {
    try { workflow = await readFile(source, 'utf8'); }
    catch { throw new CloudFlowError('invalid_input', 'Cannot read --source; supply the original flow file.'); }
  }
  if (typeof workflow !== 'string' || createHash('sha256').update(workflow).digest('hex') !== authority.source.sha256) {
    throw new CloudFlowError('unsupported_source', `Supply --source <path> with the original flow bytes (sha256 ${authority.source.sha256}); stored source is missing, truncated or different.`);
  }
  if (record.workspaceId !== undefined && record.workspaceId !== null && typeof record.workspaceId !== 'string') {
    throw new CloudFlowError('invalid_response', 'Cloud returned an invalid workspaceId.');
  }
  return { workflow, authoredAuthority: authority, fileType: 'ts', relayflowVersion: 'v2', resume: runId,
    ...(typeof record.workspaceId === 'string' ? { workspaceId: record.workspaceId } : {}) };
}

/** Record a decision and resume only if Cloud still reports the original park. No POST retries. */
export async function answerCloudFlow(runId: string, answer: boolean, options: CloudAnswerOptions = {}): Promise<CloudResumeReceipt> {
  cloudRunId(runId);
  const record = await get(route(runId), options);
  const state = cloudRunState(record, runId);
  if (state.status !== 'needs_human') throw new CloudFlowError('invalid_input', 'Run is not parked on needs_human; no answer or resume was submitted.');
  const { wait, recorded } = await readCloudHumanWait(runId, options);
  const waitId = wait?.waitId ?? recorded?.waitId;
  if (!waitId || (state.humanWait && state.humanWait.waitId !== waitId)) {
    throw new CloudFlowError('invalid_response', 'Cloud answer record does not identify the run’s parked wait.');
  }
  if (recorded && (recorded.waitId !== waitId || recorded.answer !== answer || recorded.note !== options.note)) {
    throw new CloudFlowError('invalid_input', 'The recorded answer differs; a closed human wait cannot be changed.');
  }
  const body = await resumeBody(record as Record<string, unknown>, runId, options.source);
  let answerRecorded = recorded !== undefined;
  try {
    if (!answerRecorded) {
      const accepted = await post(`${route(runId)}/answer`, { waitId, answer, ...(options.note === undefined ? {} : { note: options.note }) }, options);
      if (!isCloudRecord(accepted) || accepted.ok === false || accepted.error !== undefined) {
        throw new CloudFlowError('invalid_response', 'Cloud did not confirm the human answer.');
      }
      answerRecorded = true;
    }
    const current = cloudRunState(await get(route(runId), options), runId);
    if (current.status !== 'needs_human') {
      if (!isCloudRunActive(current.status) && current.status !== 'completed') {
        throw new CloudFlowError('invalid_response', 'Run left the human park without a confirmed resume.');
      }
      return { runId, resumedFrom: runId, waitId, answer, resumedByCloud: true };
    }
    if (current.humanWait && current.humanWait.waitId !== waitId) {
      throw new CloudFlowError('invalid_response', 'Run is now parked on a different human wait; refusing to resume it.');
    }
    const receipt = await post('/api/v1/workflows/run', body, options);
    if (!isCloudRecord(receipt) || !['pending', 'running'].includes(String(receipt.status))) {
      throw new CloudFlowError('invalid_response', 'Cloud did not return an accepted resume.');
    }
    return { runId: cloudRunId(receipt.runId), resumedFrom: runId, waitId, answer, resumedByCloud: false };
  } catch (error) {
    throw new CloudAnswerError(answerRecorded, error);
  }
}
