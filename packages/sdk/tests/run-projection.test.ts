import { describe, expect, it, vi } from 'vitest';
import { createJournalProjector } from '../src/journal-projection.js';
import type { JournalEvent } from '../src/journal-reader.js';
import { createRunProjection, type ProjectionFetch } from '../src/run-projection.js';

type Call = { url: string; method: string; body: Record<string, unknown> | undefined; headers: Record<string, string> };

/** A Relaycast stand-in: records every request, answers by path. */
function relaycast(overrides: Record<string, { status: number; body: unknown }> = {}) {
  const calls: Call[] = [];
  const fetch: ProjectionFetch = vi.fn(async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ url: path, method: init.method, headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body) as Record<string, unknown> });
    const override = overrides[path];
    const status = override?.status ?? (path === '/v1/agents' ? 201 : 200);
    const body = override?.body ?? (path === '/v1/agents' ? { ok: true, data: { token: 'at_live_pub' } } : { ok: true, data: {} });
    return { ok: status < 300, status, json: async () => body };
  });
  return { fetch, calls };
}

const run = { runId: '01RUN', flow: 'hello-deterministic', steps: [
  { id: 'greet', type: 'deterministic' as const, dependsOn: [] },
  { id: 'shout', type: 'deterministic' as const, dependsOn: ['greet'] },
] };

describe('createRunProjection', () => {
  it('registers a publisher, opens wf-<runId>, and posts each transition with the run snapshot', async () => {
    const { fetch, calls } = relaycast();
    const projection = createRunProjection({ workspaceKey: 'rk_live_k', fetch, diagnostic: vi.fn() }, run);
    projection.step({ type: 'step.started', stepId: 'greet', stepType: 'deterministic', elapsedMs: 0, attempt: 1 });
    projection.step({ type: 'step.completed', stepId: 'greet', stepType: 'deterministic', elapsedMs: 12.4, completionReason: 'success' });
    projection.finish({ status: 'completed', completionReason: 'success' });
    projection.finish({ status: 'failed' });
    await projection.drain(1_000);

    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'POST /v1/agents',
      'POST /v1/channels',
      'POST /v1/channels/wf-01run/messages',
      'POST /v1/channels/wf-01run/messages',
      'POST /v1/channels/wf-01run/messages',
      'POST /v1/channels/wf-01run/messages',
    ]);
    expect(calls[0]!.headers['Authorization']).toBe('Bearer rk_live_k');
    expect(calls[1]!.headers['Authorization']).toBe('Bearer at_live_pub');
    const posts = calls.slice(2).map(call => call.body as { text: string; data: { relayflow: { event: string; run: {
      status: string; steps: Array<{ id: string; state: string; elapsedMs?: number }> } } } });
    expect(posts.map(post => post.text)).toEqual([
      '▶ hello-deterministic started · 2 steps · run 01RUN',
      '○ greet (deterministic) started',
      '✓ greet (deterministic) 0.01s completionReason: success',
      '■ hello-deterministic completed · completionReason: success',
    ]);
    expect(posts.map(post => post.data.relayflow.event)).toEqual(['run.started', 'step.started', 'step.completed', 'run.completed']);
    expect(posts[0]!.data.relayflow.run.steps.map(step => step.state)).toEqual(['pending', 'pending']);
    expect(posts[2]!.data.relayflow.run.steps[0]).toMatchObject({ id: 'greet', state: 'completed', elapsedMs: 12 });
    expect(posts[3]!.data.relayflow.run.status).toBe('completed');
    // Every post carries its own idempotency key.
    expect(new Set(calls.slice(2).map(call => call.headers['Idempotency-Key'])).size).toBe(4);
  });

  it('joins the channel when agent communication created it first', async () => {
    const { fetch, calls } = relaycast({ '/v1/channels': { status: 409, body: { ok: false, error: { code: 'channel_already_exists' } } } });
    const projection = createRunProjection({ workspaceKey: 'rk_live_k', fetch, diagnostic: vi.fn() }, run);
    await projection.drain(1_000);
    expect(calls.map(call => call.url)).toEqual(['/v1/agents', '/v1/channels', '/v1/channels/wf-01run/join', '/v1/channels/wf-01run/messages']);
  });

  it('reports a failure once, stops publishing, and never throws into the run', async () => {
    const { fetch, calls } = relaycast({ '/v1/agents': { status: 401, body: { ok: false, error: { code: 'unauthorized' } } } });
    const diagnostic = vi.fn();
    const projection = createRunProjection({ workspaceKey: 'rk_live_bad', fetch, diagnostic }, run);
    projection.step({ type: 'step.started', stepId: 'greet', stepType: 'deterministic', elapsedMs: 0 });
    projection.finish({ status: 'completed' });
    await projection.drain(1_000);
    expect(calls).toHaveLength(1);
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic.mock.calls[0]![0]).toContain('HTTP 401 unauthorized');
  });
});

describe('createJournalProjector', () => {
  const entry = (seq: number, entry_type: string, at_ms: number, step_id: string | null = null,
    payload: unknown = {}, attempt: number | null = step_id === null ? null : 1): JournalEvent =>
    ({ seq, segment_id: 1, entry_type, run_id: '01RUN', step_id, attempt, at_ms, payload });
  const spawned = entry(1, 'run.spawned', 1_000, null, { spec: { name: 'hello', steps: [
    { id: 'greet', type: 'deterministic', depends_on: [] },
    { id: 'plan', type: 'llm', depends_on: ['greet'] },
  ] } });

  function recorder() {
    const opened: unknown[] = [];
    const steps: Array<{ type: string; stepId: string; stepType: string; elapsedMs: number; completionReason?: string; publish: boolean }> = [];
    const finished: unknown[] = [];
    const open = vi.fn((declared: unknown) => {
      opened.push(declared);
      return {
        channel: 'wf-01run',
        step: (event: { type: string; stepId: string; stepType: string; elapsedMs: number; completionReason?: string }, publish = true) =>
          { steps.push({ ...event, publish }); },
        finish: (outcome: unknown) => { finished.push(outcome); },
        drain: async () => {},
      };
    });
    return { open, opened, steps, finished };
  }

  it('opens on run.spawned with the declared graph and maps attempts and completions', () => {
    const r = recorder();
    const project = createJournalProjector(r.open);
    for (const e of [
      spawned,
      entry(2, 'step.routed', 1_000, 'greet'),
      entry(3, 'step.attempt.started', 1_010, 'greet'),
      entry(4, 'step.completed', 1_260, 'greet', { completionReason: 'success', disposition: 'step_done' }),
      entry(5, 'step.attempt.started', 1_300, 'plan'),
      entry(6, 'step.completed', 1_500, 'plan', { completionReason: 'verification_failed', disposition: 'retry' }),
      entry(7, 'run.completed', 1_600, null, { completionReason: 'step_failed' }),
    ]) project(e);

    expect(r.opened).toEqual([{ runId: '01RUN', flow: 'hello', steps: [
      { id: 'greet', type: 'deterministic', dependsOn: [] },
      { id: 'plan', type: 'llm', dependsOn: ['greet'] },
    ] }]);
    expect(r.steps.map(s => [s.type, s.stepId, s.stepType, s.elapsedMs, s.completionReason])).toEqual([
      ['step.started', 'greet', 'deterministic', 0, undefined],
      ['step.completed', 'greet', 'deterministic', 250, 'success'],
      ['step.started', 'plan', 'llm', 0, undefined],
      ['step.failed', 'plan', 'llm', 200, 'verification_failed'],
    ]);
    expect(r.finished).toEqual([{ status: 'failed', completionReason: 'step_failed' }]);
  });

  it('folds entries journaled before liveSinceMs without publishing them', () => {
    const r = recorder();
    const project = createJournalProjector(r.open, 1_200);
    project(spawned);
    project(entry(3, 'step.attempt.started', 1_010, 'greet'));
    project(entry(4, 'step.completed', 1_260, 'greet', { completionReason: 'success', disposition: 'step_done' }));
    expect(r.steps.map(s => s.publish)).toEqual([false, true]);
  });

  it('ignores step entries before run.spawned and a second run.spawned', () => {
    const r = recorder();
    const project = createJournalProjector(r.open);
    project(entry(3, 'step.attempt.started', 1_010, 'greet'));
    project(spawned);
    project(spawned);
    expect(r.open).toHaveBeenCalledOnce();
    expect(r.steps).toEqual([]);
  });
});
