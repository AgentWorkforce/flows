import { CloudFlowError } from '../cloud-http.js';
import { listCloudSchedules, scheduleInCloud, unscheduleInCloud, validateScheduleArgs, type CloudSchedule } from '../cloud-schedule.js';
import { DirectInputError, isAuthoredFlowPath, parseDirectInput } from '../direct-input.js';
import { snapshotJsonValue, type JsonValue } from '../json-value.js';
import { cliConnectPrompt, ensureFlowConnections, harnessRemedy } from './cloud-connect-cli.js';
import type { CliIo } from '../cli.js';

export interface CloudScheduleArgs {
  command: 'schedule';
  value: string;
  cron: string | undefined;
  every: string | undefined;
  tz: string | undefined;
  input: string | undefined;
  name: string | undefined;
  /** Refuse a missing integration instead of offering to connect it. */
  noConnect: boolean;
  json: boolean;
}

/**
 * `flows schedule <flow.yaml|flow.ts> [--cron "<expr>" | --every <n><s|m|h|d>]
 *   [--tz <IANA>] [--input <json|file>] [--name <n>] [--no-connect] [--json]`
 *
 * With neither `--cron` nor `--every`, the flow's own `schedule.*` handler
 * supplies the cron, so a declared schedule and its hosted registration
 * cannot drift.
 */
export function parseCloudScheduleArgs(args: readonly string[]): CloudScheduleArgs | undefined {
  let value: string | undefined;
  const flags: Record<'cron' | 'every' | 'tz' | 'input' | 'name', string | undefined> = {
    cron: undefined, every: undefined, tz: undefined, input: undefined, name: undefined,
  };
  let json = false;
  let noConnect = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      if (json) return undefined;
      json = true;
      continue;
    }
    if (arg === '--no-connect') {
      if (noConnect) return undefined;
      noConnect = true;
      continue;
    }
    if (arg === '--cron' || arg === '--every' || arg === '--tz' || arg === '--input' || arg === '--name') {
      const key = arg.slice(2) as keyof typeof flags;
      const next = args[i + 1];
      // A cron expression legitimately starts with `*`; only a flag-shaped value is refused.
      if (flags[key] !== undefined || next === undefined || next.startsWith('--')) return undefined;
      flags[key] = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('-') || value !== undefined) return undefined;
    value = arg;
  }
  if (value === undefined) return undefined;
  if (flags.cron !== undefined && flags.every !== undefined) return undefined;
  if (flags.input !== undefined && !isAuthoredFlowPath(value)) return undefined;
  return { command: 'schedule', value, ...flags, noConnect, json };
}

function describe(schedule: CloudSchedule): string {
  const last = schedule.lastTriggeredAt === undefined ? ''
    : ` last ${schedule.lastTriggeredAt}${schedule.lastTriggerStatus === undefined ? '' : ` (${schedule.lastTriggerStatus})`}`;
  return `${schedule.id} ${schedule.status} ${JSON.stringify(schedule.name)} cron "${schedule.cronExpression}" tz ${schedule.timezone}${last}`;
}

export async function runCloudScheduleCli(args: CloudScheduleArgs, io: CliIo): Promise<0 | 1 | 2> {
  let harnesses: readonly string[] = [];
  try {
    let input: JsonValue | undefined;
    let inputPresent = false;
    if (isAuthoredFlowPath(args.value)) {
      try {
        input = snapshotJsonValue(parseDirectInput(args.input), 'Cloud authored input');
        inputPresent = true;
      } catch (error) {
        if (error instanceof DirectInputError) throw new CloudFlowError('invalid_input', error.message);
        throw error;
      }
    }
    validateScheduleArgs({
      ...(args.cron === undefined ? {} : { cron: args.cron }),
      ...(args.every === undefined ? {} : { every: args.every }),
      ...(args.tz === undefined ? {} : { tz: args.tz }),
    });
    // Each fire runs the flow as this workspace, so what it needs connected
    // is checked once here — after the arguments are known to be good, so a
    // refused command never opens a browser first — and before the schedule exists.
    const connections = await ensureFlowConnections({
      path: args.value, prompt: cliConnectPrompt(io, { noConnect: args.noConnect, json: args.json }),
    });
    harnesses = connections?.requirements.harnesses ?? [];
    const schedule = await scheduleInCloud({
      flow: { path: args.value },
      ...(args.cron === undefined ? {} : { cron: args.cron }),
      ...(args.every === undefined ? {} : { every: args.every }),
      ...(args.tz === undefined ? {} : { tz: args.tz }),
      ...(args.name === undefined ? {} : { name: args.name }),
      ...(inputPresent ? { input } : {}),
    });
    if (args.json) {
      io.stdout(JSON.stringify({ ok: true, ...schedule }));
      return 0;
    }
    io.stdout(`SCHEDULED ${describe(schedule)}`);
    for (const provider of connections?.outcome.connected ?? []) io.stdout(`  connected: ${provider}`);
    io.stdout('Each fire submits this exact source through the same admission as flows run --cloud; list with: flows schedules');
    return 0;
  } catch (error) {
    return reportFailure(error, args.json, io, harnesses);
  }
}

export async function runCloudSchedulesCli({ json }: { json: boolean }, io: CliIo): Promise<0 | 1 | 2> {
  try {
    const schedules = await listCloudSchedules();
    if (json) {
      io.stdout(JSON.stringify({ ok: true, schedules }));
      return 0;
    }
    if (schedules.length === 0) io.stdout('No workflow schedules in this workspace.');
    for (const schedule of schedules) io.stdout(describe(schedule));
    return 0;
  } catch (error) {
    return reportFailure(error, json, io);
  }
}

export async function runCloudUnscheduleCli(
  { scheduleId, json }: { scheduleId: string; json: boolean }, io: CliIo,
): Promise<0 | 1 | 2> {
  try {
    await unscheduleInCloud(scheduleId);
    io.stdout(json ? JSON.stringify({ ok: true, scheduleId, deleted: true }) : `UNSCHEDULED ${scheduleId}`);
    return 0;
  } catch (error) {
    return reportFailure(error, json, io);
  }
}

function reportFailure(error: unknown, json: boolean, io: CliIo, harnesses: readonly string[] = []): 1 | 2 {
  const code = error instanceof CloudFlowError ? error.code : 'cloud_schedule_failed';
  let message = error instanceof Error ? error.message : 'Cloud schedule failed.';
  message += harnessRemedy(error, harnesses);
  // The schedule routes take a browser session or a `cli:auth` token.
  if (error instanceof CloudFlowError && error.status === 403) {
    message += ' Scheduling needs an interactive `cli:auth` credential: run `agent-relay cloud login`.';
  }
  if (json) io.stdout(JSON.stringify({ ok: false, code, message }));
  else io.stderr(`${code}: ${message}`);
  return error instanceof CloudFlowError
    && (['configuration', 'unsupported_source', 'invalid_input', 'integration_not_connected'].includes(error.code)
      || error.status === 403 || error.status === 401)
    ? 2 : 1;
}
