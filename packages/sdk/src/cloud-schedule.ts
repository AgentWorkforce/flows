import { cronGrid, everyToMs, parseCron, type ScheduleTriggerSource } from '@relayflows/surface';
import { CloudFlowError, cloudFetch, cloudRequest, isCloudRecord, type CloudConnectionOptions } from './cloud-http.js';
import { cloudSubmissionBody, prepareCloudSubmission, type CloudFlowSource } from './cloud-run.js';
import type { JsonValue } from './json-value.js';

/**
 * Hosted schedules. `POST /api/v1/workflows/schedules` stores a workflow
 * request and relaycron fires it on the cron; each fire replays the stored
 * request through the same `/workflows/run` admission a `flows run --cloud`
 * takes. So a schedule sends exactly what a run sends — `prepareCloudSubmission`
 * — wrapped in the schedule envelope. Nothing runs at schedule time.
 */

export interface ScheduleInCloudInput {
  flow: CloudFlowSource;
  /** Five-field cron. Exactly one of `cron` or `every`, or neither to use the flow's declared `schedule.*`. */
  cron?: string;
  /** Fixed interval such as `5m`; lowered to a cron the server accepts. */
  every?: string;
  /** IANA zone the cron is evaluated in; default UTC. */
  tz?: string;
  /** Authored input, as `flows run --cloud --input`. */
  input?: JsonValue;
  /** Defaults to the flow's declared name. */
  name?: string;
}

export interface CloudSchedule {
  id: string;
  name: string;
  cronExpression: string;
  timezone: string;
  status: string;
  createdAt?: string;
  lastTriggeredAt?: string;
  lastTriggeredRunId?: string;
  lastTriggerStatus?: string;
}

const SCHEDULE_ID = /^[A-Za-z0-9_-]{1,128}$/u;

/** `every("5m")` as a cron the server accepts; only intervals cron can express exactly. */
export function everyToCron(every: string): string {
  const ms = everyToMs(every);
  const minutes = ms / 60_000;
  if (Number.isInteger(minutes) && minutes >= 1 && minutes < 60 && 60 % minutes === 0) return `*/${minutes} * * * *`;
  if (minutes === 60) return '0 * * * *';
  const hours = ms / 3_600_000;
  if (Number.isInteger(hours) && hours > 1 && hours < 24 && 24 % hours === 0) return `0 */${hours} * * *`;
  if (hours === 24) return '0 0 * * *';
  throw new CloudFlowError('invalid_input',
    `--every ${every} has no exact cron: use a divisor of an hour (1m-30m), 1h, a divisor of a day (2h-12h), or 1d; or give --cron.`);
}

/** The cron a declared `schedule.*` source means on Cloud. */
export function declaredScheduleCron(source: ScheduleTriggerSource): { cron: string; tz?: string } {
  if (source.cron !== undefined) return { cron: source.cron, ...(source.tz === undefined ? {} : { tz: source.tz }) };
  const minutes = (source.intervalMs ?? 0) / 60_000;
  const every = Number.isInteger(minutes) ? `${minutes}m` : `${Math.round((source.intervalMs ?? 0) / 1000)}s`;
  return { cron: everyToCron(every) };
}

function assertTimeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new CloudFlowError('invalid_input', `--tz ${JSON.stringify(tz)} is not a known IANA zone.`);
  }
  return tz;
}

export async function scheduleInCloud(
  input: ScheduleInCloudInput, options: CloudConnectionOptions = {},
): Promise<CloudSchedule> {
  if (input.cron !== undefined && input.every !== undefined) {
    throw new CloudFlowError('invalid_input', 'Give --cron or --every, not both.');
  }
  const submission = await prepareCloudSubmission(input.flow, {
    ...(Object.prototype.hasOwnProperty.call(input, 'input') ? { input: input.input } : {}),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  let cron: string;
  let tz = input.tz;
  if (input.cron !== undefined) {
    try { parseCron(input.cron); } catch (error) {
      throw new CloudFlowError('invalid_input', `--cron: ${error instanceof Error ? error.message : String(error)}`);
    }
    cron = input.cron.trim();
  } else if (input.every !== undefined) {
    cron = everyToCron(input.every);
  } else {
    if (submission.schedules.length !== 1) {
      throw new CloudFlowError('invalid_input', submission.schedules.length === 0
        ? 'The flow declares no schedule.* handler; give --cron or --every.'
        : 'The flow declares several schedules; say which with --cron or --every.');
    }
    const declared = declaredScheduleCron(submission.schedules[0]!);
    cron = declared.cron;
    tz ??= declared.tz;
  }
  const timezone = tz === undefined ? 'UTC' : assertTimeZone(tz);
  const name = (input.name ?? submission.name).trim();
  if (!name) throw new CloudFlowError('invalid_input', 'Schedule name must not be empty.');
  options.signal?.throwIfAborted();
  const result = await cloudFetch('/api/v1/workflows/schedules', options, {
    method: 'POST', detail: true,
    body: JSON.stringify({
      name,
      schedule_type: 'cron',
      cron_expression: cron,
      timezone,
      workflowRequest: cloudSubmissionBody(submission),
    }),
  });
  const record = isCloudRecord(result) && isCloudRecord(result.schedule) ? result.schedule : undefined;
  if (record === undefined) throw new CloudFlowError('invalid_response', 'Cloud did not return a schedule.');
  return toCloudSchedule(record);
}

function toCloudSchedule(row: Record<string, unknown>): CloudSchedule {
  if (typeof row.id !== 'string' || !SCHEDULE_ID.test(row.id) || typeof row.name !== 'string') {
    throw new CloudFlowError('invalid_response', 'Cloud returned a malformed schedule.');
  }
  const optional = (key: string): Record<string, string> =>
    typeof row[key] === 'string' ? { [key]: row[key] as string } : {};
  return {
    id: row.id, name: row.name,
    cronExpression: typeof row.cronExpression === 'string' ? row.cronExpression : '',
    timezone: typeof row.timezone === 'string' ? row.timezone : 'UTC',
    status: typeof row.status === 'string' ? row.status : 'unknown',
    ...optional('createdAt'), ...optional('lastTriggeredAt'), ...optional('lastTriggeredRunId'), ...optional('lastTriggerStatus'),
  };
}

export async function listCloudSchedules(options: CloudConnectionOptions = {}): Promise<CloudSchedule[]> {
  const payload = await cloudRequest('/api/v1/workflows/schedules', options);
  if (!isCloudRecord(payload) || !Array.isArray(payload.schedules)) {
    throw new CloudFlowError('invalid_response', 'Cloud did not return a schedules list.');
  }
  return payload.schedules.map(row => {
    if (!isCloudRecord(row)) throw new CloudFlowError('invalid_response', 'Cloud returned a malformed schedule row.');
    return toCloudSchedule(row);
  });
}

export async function unscheduleInCloud(scheduleId: string, options: CloudConnectionOptions = {}): Promise<void> {
  if (!SCHEDULE_ID.test(scheduleId)) throw new CloudFlowError('invalid_input', `"${scheduleId}" is not a schedule id.`);
  const result = await cloudFetch(`/api/v1/workflows/schedules/${encodeURIComponent(scheduleId)}`, options,
    { method: 'DELETE', detail: true });
  if (!isCloudRecord(result) || result.deleted !== true) {
    throw new CloudFlowError('invalid_response', 'Cloud did not confirm the deletion.');
  }
}

/** Exposed for previews: the tick grid a UTC cron amounts to, if it is exactly one. */
export function cronIntervalMs(cron: string): number | undefined {
  return cronGrid(parseCron(cron))?.intervalMs;
}
