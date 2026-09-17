import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schedule, scheduleIdFor } from '@relayflows/surface';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { declaredScheduleCron, everyToCron, scheduleInCloud } from '../src/cloud-schedule.js';
import { SCHEDULE_EXECUTOR, scheduleLowering, scheduleTriggerSpec } from '../src/schedule-trigger.js';
import { TICK_DEDUPE_KEY_TEMPLATE, TICK_EVENT_TYPE } from '../src/tick-source.js';
import { compileSpec, toKernelSpec } from '../src/compile.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

interface Call { method: string; path: string; auth: string | undefined; body: unknown }
function cloud(routes: Record<string, (call: Call) => { status?: number; body: unknown } | unknown>) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    init?.signal?.throwIfAborted();
    const path = new URL(String(input)).pathname;
    const call: Call = { method: init?.method ?? 'GET', path,
      auth: new Headers(init?.headers).get('authorization') ?? undefined,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const route = routes[path];
    if (!route) return new Response('{"error":"not found"}', { status: 404 });
    const answer = route(call);
    const { status, body } = answer !== null && typeof answer === 'object' && 'status' in answer && 'body' in answer
      ? answer as { status?: number; body: unknown } : { status: 200, body: answer };
    return new Response(JSON.stringify(body), { status: status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubEnv('FLOWS_CLOUD_URL', 'https://cloud-contract.example');
  vi.stubEnv('FLOWS_CLOUD_TOKEN', 'test-cli-auth-token');
  return calls;
}

const SCHEDULE_ROW = { id: 'sched-1', name: 'nightly', cronExpression: '0 9 * * 1-5', timezone: 'Europe/Oslo', status: 'active', createdAt: '2026-09-17T20:00:00.000Z' };

async function authoredFlow(body: string, name = 'nightly'): Promise<string> {
  const dir = await tempDir('cloud-schedule-');
  await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
  const path = join(dir, `${name}.flow.ts`);
  await writeFile(path, `import { flow, schedule } from '@relayflows/surface';\n${body}\n`);
  return path;
}

describe('schedule lowering', () => {
  it('lowers every() and grid crons to the flows.tick subscription the tick runner drives', () => {
    const every5 = schedule.every('5m');
    const id = scheduleIdFor('nightly report', every5);
    const spec = scheduleTriggerSpec('nightly-0', 'nightly report', every5);
    expect(spec).toEqual({
      id: 'nightly-0', executor: SCHEDULE_EXECUTOR, eventType: TICK_EVENT_TYPE,
      pattern: { schedule_id: id },
      dedupeKeyTemplate: TICK_DEDUPE_KEY_TEMPLATE, staleAfterMs: 900_000,
    });
    const quarterPast = schedule.cron('15 * * * *');
    expect(scheduleLowering('nightly', quarterPast)).toEqual({
      scheduleId: scheduleIdFor('nightly', quarterPast), cron: '15 * * * *',
      intervalMs: 3_600_000, epochMs: 900_000, staleAfterMs: 10_800_000,
    });
    // It compiles as a real trigger, so a YAML author gets the same subscription.
    const kernel = toKernelSpec(compileSpec({
      version: '0.1.0', name: 'nightly', triggers: [spec],
      steps: [{ id: 'ack', type: 'deterministic', command: 'printf tick' }],
    }));
    expect(kernel.triggers?.[0]).toMatchObject({ event_type: 'flows.tick', pattern: { schedule_id: id }, stale_after_ms: 900_000 });
  });

  it('marks a non-grid cron as Cloud-only rather than approximating it, with a silence budget from its own cadence', () => {
    const weekdays = schedule.cron('0 9 * * 1-5', { tz: 'Europe/Oslo' });
    const lowering = scheduleLowering('nightly', weekdays);
    expect(lowering).toMatchObject({ scheduleId: scheduleIdFor('nightly', weekdays), cron: '0 9 * * 1-5', tz: 'Europe/Oslo' });
    expect(lowering.intervalMs).toBeUndefined();
    expect(lowering.epochMs).toBeUndefined();
    expect(lowering.localUnsupported).toContain('not a UTC tick grid');
    // Friday 09:00 → Monday 09:00 is 72 h; three of those, never the kernel's 5-minute default.
    expect(lowering.staleAfterMs).toBe(3 * 72 * 3_600_000);
    expect(scheduleTriggerSpec('n-0', 'nightly', schedule.cron('0 9 * * 1-5')).staleAfterMs).toBe(3 * 72 * 3_600_000);
    // */7 is not a grid either: cron restarts the count each hour.
    expect(scheduleLowering('n', schedule.cron('*/7 * * * *')).localUnsupported).toBeDefined();
  });
});

describe('every → cron', () => {
  it('maps exact intervals and refuses the rest', () => {
    expect(everyToCron('5m')).toBe('*/5 * * * *');
    expect(everyToCron('1h')).toBe('0 * * * *');
    expect(everyToCron('6h')).toBe('0 */6 * * *');
    expect(everyToCron('1d')).toBe('0 0 * * *');
    for (const bad of ['7m', '90m', '5h', '30s', '2d']) {
      expect(() => everyToCron(bad), bad).toThrow(expect.objectContaining({ code: 'invalid_input' }));
    }
    expect(declaredScheduleCron(schedule.every('15m'))).toEqual({ cron: '*/15 * * * *' });
    expect(declaredScheduleCron(schedule.cron('0 9 * * 1-5', { tz: 'UTC' }))).toEqual({ cron: '0 9 * * 1-5', tz: 'UTC' });
  });
});

describe('flows check prints declared schedules', () => {
  it('shows the lowering for a fixed interval and the Cloud-only note for a real cron', async () => {
    const path = await authoredFlow(
      "export default flow('nightly')\n"
      + "  .on(schedule.every('5m'), async f => f.done('success'))\n"
      + "  .on(schedule.cron('0 9 * * 1-5', { tz: 'Europe/Oslo' }), async f => f.done('success'));",
    );
    const out: string[] = [];
    const code = await runCli(['check', path], { stdout: line => out.push(line), stderr: line => out.push(`ERR ${line}`) });
    expect(code, out.join('\n')).toBe(0);
    const everyId = scheduleIdFor('nightly', schedule.every('5m'));
    const cronId = scheduleIdFor('nightly', schedule.cron('0 9 * * 1-5', { tz: 'Europe/Oslo' }));
    expect(out).toContainEqual(`SCHEDULE handler 0 every 300000ms -> flows.tick schedule_id ${everyId} [local: flows tick start --schedule-id ${everyId} --interval-ms 300000 --epoch-ms 0]`);
    expect(out.find(l => l.includes(cronId))).toMatch(/^SCHEDULE handler 1 cron "0 9 \* \* 1-5" tz Europe\/Oslo -> flows\.tick schedule_id .* \[Cloud only: /u);
    expect(out.some(l => l.includes('no_executor'))).toBe(false);
    const json: string[] = [];
    expect(await runCli(['check', '--json', path], { stdout: line => json.push(line), stderr: () => {} })).toBe(0);
    expect(JSON.parse(json[0]!).schedules).toHaveLength(2);
  });
});

describe('flows schedule / schedules / unschedule', () => {
  it('schedules an authored flow from its declared schedule, sending exactly the run body inside the envelope', async () => {
    const path = await authoredFlow("export default flow('nightly').on(schedule.cron('0 9 * * 1-5', { tz: 'Europe/Oslo' }), async f => f.done('success'));");
    const calls = cloud({ '/api/v1/workflows/schedules': () => ({ status: 201, body: { schedule: SCHEDULE_ROW } }) });
    const out: string[] = [];
    const code = await runCli(['schedule', path, '--input', '{"topic":"release"}'], { stdout: line => out.push(line), stderr: line => out.push(`ERR ${line}`) });
    expect(code, out.join('\n')).toBe(0);
    expect(out[0]).toBe('SCHEDULED sched-1 active "nightly" cron "0 9 * * 1-5" tz Europe/Oslo');
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ name: 'nightly', schedule_type: 'cron', cron_expression: '0 9 * * 1-5', timezone: 'Europe/Oslo' });
    const request = body.workflowRequest as Record<string, unknown>;
    expect(request).toMatchObject({ fileType: 'ts', relayflowVersion: 'v2', inputs: { topic: 'release' } });
    expect(request.workflow).toContain("schedule.cron('0 9 * * 1-5'");
    expect(request.authoredAuthority).toMatchObject({ schemaVersion: 1, surface: { packageName: '@relayflows/surface' } });
    expect(Object.keys(request).sort()).toEqual(['authoredAuthority', 'fileType', 'inputs', 'relayflowVersion', 'workflow']);
  });

  it('schedules a declarative flow with --every, and --cron/--tz override a declaration', async () => {
    const dir = await tempDir('cloud-schedule-yaml-');
    const yaml = join(dir, 'monitor.flow.yaml');
    await writeFile(yaml, JSON.stringify({ version: '0.1.0', name: 'monitor', steps: [{ id: 'ls', type: 'deterministic', command: 'ls' }] }));
    const calls = cloud({ '/api/v1/workflows/schedules': () => ({ status: 201, body: { schedule: { ...SCHEDULE_ROW, name: 'monitor', cronExpression: '*/15 * * * *', timezone: 'UTC' } } }) });
    expect(await runCli(['schedule', yaml, '--every', '15m', '--json'], { stdout: () => {}, stderr: () => {} })).toBe(0);
    expect(calls[0]!.body).toMatchObject({ name: 'monitor', cron_expression: '*/15 * * * *', timezone: 'UTC',
      workflowRequest: { fileType: 'yaml', relayflowVersion: 'v2' } });
    expect((calls[0]!.body as { workflowRequest: Record<string, unknown> }).workflowRequest.inputs).toBeUndefined();

    const path = await authoredFlow("export default flow('nightly').on(schedule.every('5m'), async f => f.done('success'));");
    expect(await runCli(['schedule', path, '--cron', '30 6 * * *', '--tz', 'Europe/Oslo', '--name', 'Morning', '--input', '{}', '--json'],
      { stdout: () => {}, stderr: () => {} })).toBe(0);
    expect(calls[1]!.body).toMatchObject({ name: 'Morning', cron_expression: '30 6 * * *', timezone: 'Europe/Oslo' });
  });

  it('refuses bad crons, bad zones, missing declarations and both flags before HTTP', async () => {
    const path = await authoredFlow("export default flow('plain', async f => f.done('success'));", 'plain');
    const calls = cloud({});
    const errors: string[] = [];
    const io = { stdout: () => {}, stderr: (line: string) => errors.push(line) };
    expect(await runCli(['schedule', path, '--input', '{}'], io)).toBe(2);
    expect(errors.at(-1)).toContain('declares no schedule');
    expect(await runCli(['schedule', path, '--cron', '99 * * * *', '--input', '{}'], io)).toBe(2);
    expect(errors.at(-1)).toContain('outside 0-59');
    expect(await runCli(['schedule', path, '--every', '7m', '--input', '{}'], io)).toBe(2);
    expect(errors.at(-1)).toContain('no exact cron');
    expect(await runCli(['schedule', path, '--cron', '0 9 * * *', '--tz', 'Mars/Olympus', '--input', '{}'], io)).toBe(2);
    expect(errors.at(-1)).toContain('IANA');
    expect(await runCli(['schedule', path, '--cron', '0 9 * * *'], io)).toBe(2); // authored flows need --input
    expect(calls).toHaveLength(0);
    await expect(scheduleInCloud({ flow: { path }, cron: '0 9 * * *', every: '5m', input: {} }))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });

  it.each([
    ['schedule'], ['schedule', 'x.flow.ts', '--cron', '* * * * *', '--every', '5m'], ['schedule', 'x.flow.ts', '--cron'],
    ['schedule', 'a.flow.yaml', '--input', '{}', '--cron', '* * * * *'], ['schedule', 'x.flow.ts', '--json', '--json'],
    ['schedules', 'extra'], ['unschedule'], ['unschedule', 'a', 'b'],
  ])('refuses argv %j before any request', async (...args) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect(await runCli(args, { stdout: () => {}, stderr: () => {} })).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('names a structured refusal from the schedule route', async () => {
    const path = await authoredFlow("export default flow('nightly').on(schedule.every('5m'), async f => f.done('success'));");
    cloud({ '/api/v1/workflows/schedules': () => ({ status: 400, body: { error: 'scheduled relayflowVersion v2 ts workflows require inputs', code: 'invalid_request' } }) });
    const errors: string[] = [];
    expect(await runCli(['schedule', path, '--input', '{}'], { stdout: () => {}, stderr: line => errors.push(line) })).toBe(1);
    expect(errors[0]).toContain('scheduled relayflowVersion v2 ts workflows require inputs');
  });

  it('lists and deletes schedules', async () => {
    const calls = cloud({
      '/api/v1/workflows/schedules': () => ({ schedules: [SCHEDULE_ROW, { ...SCHEDULE_ROW, id: 'sched-2', name: 'monitor', status: 'paused', lastTriggeredAt: '2026-09-17T19:00:00.000Z', lastTriggerStatus: 'launched' }] }),
      '/api/v1/workflows/schedules/sched-2': () => ({ deleted: true }),
    });
    const out: string[] = [];
    expect(await runCli(['schedules'], { stdout: line => out.push(line), stderr: () => {} })).toBe(0);
    expect(out).toEqual([
      'sched-1 active "nightly" cron "0 9 * * 1-5" tz Europe/Oslo',
      'sched-2 paused "monitor" cron "0 9 * * 1-5" tz Europe/Oslo last 2026-09-17T19:00:00.000Z (launched)',
    ]);
    const done: string[] = [];
    expect(await runCli(['unschedule', 'sched-2'], { stdout: line => done.push(line), stderr: () => {} })).toBe(0);
    expect(done).toEqual(['UNSCHEDULED sched-2']);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/v1/workflows/schedules/sched-2' });
  });
});
