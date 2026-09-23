/**
 * Project a run's lifecycle into its Relaycast channel, `wf-<runId>`, so the
 * observer dashboard shows the flow: one message per step transition, each
 * carrying the whole run snapshot under `metadata.relayflow` for a renderer
 * that draws the step graph.
 *
 * A projection, never a source of truth (RFC-0001 settled decision 7): the
 * journal is the record. Publication is serialized and fire-and-forget; a
 * failure is reported once through `diagnostic` and never reaches the run.
 */

import { randomUUID } from 'node:crypto';
import { renderProgress, type ProgressEvent } from './progress.js';
import type { StepType } from './spec.js';

export const RELAYFLOW_METADATA_VERSION = 1;

export type ProjectedStepState = 'pending' | 'running' | 'completed' | 'failed' | 'parked';

export interface ProjectedStep {
  id: string;
  type: StepType;
  dependsOn: string[];
  state: ProjectedStepState;
  attempt?: number;
  elapsedMs?: number;
  completionReason?: string;
}

export interface RunSnapshot {
  runId: string;
  flow: string;
  status: 'running' | 'completed' | 'failed' | 'parked' | 'canceled';
  completionReason?: string;
  steps: ProjectedStep[];
}

export interface DeclaredStep {
  id: string;
  type: StepType;
  dependsOn?: string[];
}

export interface RunProjection {
  readonly channel: string;
  /** Apply a transition; `publish: false` folds replayed history into the snapshot silently. */
  step(event: ProgressEvent & { attempt?: number }, publish?: boolean): void;
  /** Close the run; only the first call publishes. */
  finish(outcome: { status: RunSnapshot['status']; completionReason?: string }): void;
  /** Resolves when every queued publication settled, or after `timeoutMs`. */
  drain(timeoutMs: number): Promise<void>;
}

export type ProjectionFetch = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface RunProjectionOptions {
  workspaceKey: string;
  /** Relaycast API base, default `https://cast.agentrelay.com`. */
  baseUrl?: string;
  fetch?: ProjectionFetch;
  diagnostic: (message: string) => void;
}

const DEFAULT_BASE_URL = 'https://cast.agentrelay.com';
const REQUEST_TIMEOUT_MS = 5_000;

export function runChannelName(runId: string): string {
  return `wf-${runId.toLowerCase()}`;
}

export function createRunProjection(
  options: RunProjectionOptions,
  run: { runId: string; flow: string; steps?: DeclaredStep[]; resumed?: boolean },
): RunProjection {
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as ProjectionFetch);
  const base = options.baseUrl ?? DEFAULT_BASE_URL;
  const channel = runChannelName(run.runId);
  const snapshot: RunSnapshot = {
    runId: run.runId, flow: run.flow, status: 'running',
    steps: (run.steps ?? []).map(step => ({
      id: step.id, type: step.type, dependsOn: step.dependsOn ?? [], state: 'pending',
    })),
  };

  const call = async (path: string, token: string, body?: unknown, idempotencyKey?: string): Promise<unknown> => {
    const response = await doFetch(new URL(`/v1${path}`, base).toString(), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const parsed = await response.json().catch(() => undefined) as
      { data?: unknown; error?: { code?: string } } | undefined;
    if (!response.ok) {
      throw new RelaycastError(response.status, parsed?.error?.code ?? `http_${response.status}`);
    }
    return parsed?.data;
  };

  // A per-session publisher: agent names are unique per workspace, and a
  // resumed run publishes from a fresh session into the same channel.
  const setup = (async (): Promise<string> => {
    const agent = await call('/agents', options.workspaceKey, {
      name: `${slug(run.flow)}-${randomUUID().slice(0, 6)}`, type: 'agent', auto_join_general: false,
    }) as { token?: unknown } | undefined;
    if (typeof agent?.token !== 'string') throw new RelaycastError(0, 'agent_token_missing');
    const token = agent.token;
    try {
      await call('/channels', token, { name: channel, topic: `relayflow ${run.flow} · run ${run.runId}` });
    } catch (error) {
      // Agent communication in the same run may have created it first.
      if (!(error instanceof RelaycastError) || error.code !== 'channel_already_exists') throw error;
      await call(`/channels/${encodeURIComponent(channel)}/join`, token, {});
    }
    return token;
  })();

  let queue: Promise<unknown> = setup;
  let failed = false;
  let sequence = 0;
  const sessionId = randomUUID().slice(0, 8);
  const publish = (event: string, text: string): void => {
    const data = { relayflow: { version: RELAYFLOW_METADATA_VERSION, event, run: structuredClone(snapshot) } };
    const key = `${sessionId}-${++sequence}`;
    queue = queue.then(async () => {
      if (failed) return;
      await call(`/channels/${encodeURIComponent(channel)}/messages`, await setup, { text, data }, key);
    }).catch((error: unknown) => {
      if (failed) return;
      failed = true;
      options.diagnostic(`run projection to #${channel} failed (${errorMessage(error)}); `
        + 'the observer will not show this run, which is unaffected');
    });
  };

  const declared = snapshot.steps.length;
  publish('run.started', `▶ ${run.flow} ${run.resumed ? 'resumed' : 'started'}`
    + `${declared > 0 ? ` · ${declared} step${declared === 1 ? '' : 's'}` : ''} · run ${run.runId}`);

  return {
    channel,
    step(event, shouldPublish = true) {
      let step = snapshot.steps.find(candidate => candidate.id === event.stepId);
      if (step === undefined) {
        step = { id: event.stepId, type: event.stepType, dependsOn: [], state: 'pending' };
        snapshot.steps.push(step);
      }
      step.state = STATE[event.type];
      if (event.attempt !== undefined) step.attempt = event.attempt;
      if (event.type === 'step.started') {
        delete step.elapsedMs;
        delete step.completionReason;
      } else {
        step.elapsedMs = Math.max(0, Math.round(event.elapsedMs));
      }
      if (event.completionReason !== undefined) step.completionReason = event.completionReason;
      if (!shouldPublish || event.type === 'step.running') return;
      publish(event.type, event.type === 'step.started'
        ? `○ ${step.id} (${step.type}) started${step.attempt !== undefined && step.attempt > 1 ? ` · attempt ${step.attempt}` : ''}`
        : renderProgress([event])[0]!);
    },
    finish(outcome) {
      if (snapshot.status !== 'running') return;
      snapshot.status = outcome.status;
      if (outcome.completionReason !== undefined) snapshot.completionReason = outcome.completionReason;
      const icon = outcome.status === 'completed' ? '■' : outcome.status === 'parked' ? '⏸' : '✗';
      publish('run.completed', `${icon} ${run.flow} ${outcome.status}`
        + `${outcome.completionReason === undefined ? '' : ` · completionReason: ${outcome.completionReason}`}`);
    },
    async drain(timeoutMs) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        queue,
        new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); }),
      ]);
      clearTimeout(timer);
    },
  };
}

const STATE: Record<ProgressEvent['type'], ProjectedStepState> = {
  'step.started': 'running',
  'step.running': 'running',
  'step.completed': 'completed',
  'step.failed': 'failed',
  'step.parked': 'parked',
};

class RelaycastError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(status === 0 ? code : `HTTP ${status} ${code}`);
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'relayflow';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
