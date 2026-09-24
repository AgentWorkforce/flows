// The Cloud calls a mirrored local run makes, and nothing else.
//
// A hosted run reports through five endpoints. A local run reports through the
// same five, with the same bodies, using a credential Cloud issued for that
// one run — so the control plane cannot tell a mirrored run from a sandboxed
// one, and no route needed a new case to admit it.
//
//   POST /api/v1/workflows/local-run              register; returns the credential
//   POST /api/v1/workflows/runs/<id>/events       lifecycle events
//   POST /api/v1/workflows/runs/<id>/steps/snapshot   the live view, while it runs
//   POST /api/v1/workflows/runs/<id>/steps        the final report
//   PUT  /api/v1/workflows/runs/<id>/storage/<k>  runner log and step transcripts
//   POST /api/v1/workflows/callback               the terminal status
//
// ## Two credentials, never confused
//
// Registration authenticates as the *operator*: the `agent-relay cloud login`
// token or `FLOWS_CLOUD_TOKEN`, the same credential `flows run --cloud` uses.
// Everything after it authenticates as the *run*, with the run-bound token the
// registration returned. That token can write this run's steps and read this
// run, and can do nothing else in the workspace — so a mirror that is somehow
// coerced into pushing elsewhere has nothing to push with.
//
// ## Everything here is best-effort by construction
//
// Except `register`, which the caller needs an answer from, every function
// resolves to a boolean and throws nothing. A mirror is an observer: a run's
// correctness cannot depend on whether a report landed, and a Cloud outage
// must cost a local run nothing but its dashboard page. The caller decides
// what to retry; this module decides nothing.

import { cloudFetch, CloudFlowError, cloudConnection, cloudRunId, isCloudRecord, type CloudConnectionOptions } from './cloud-http.js';
import type { FinalStep, SnapshotStep } from './cloud-mirror-step.js';

/** What registration returns: the run, and the credential that may report on it. */
export interface MirrorRegistration {
  runId: string;
  /** The run-bound token every later call authenticates with. */
  token: string;
  /** Proves the terminal callback came from this run's executor. */
  callbackToken: string;
  /** The dashboard page for this run, as Cloud named it. */
  runUrl: string;
  /**
   * The deployment that issued the credential, pinned.
   *
   * Load-bearing, not bookkeeping. `cloudConnection` resolves the base URL
   * from the *login store* only while no explicit token is given — and every
   * call after registration gives one. Without pinning it here, a CLI signed
   * in to a staging deployment would register there and then send that
   * deployment's run token to the production default.
   */
  apiUrl: string;
}

export interface MirrorRunSource {
  /** The exact source bytes that ran: YAML/JSON text, or authored `.flow.ts`. */
  workflow: string;
  fileType: 'yaml' | 'ts';
  /** Authored runs only: the input the flow was invoked with. */
  inputs?: unknown;
}

/** One lifecycle event, in the vocabulary Cloud's session event stream uses. */
export interface MirrorEvent {
  eventType: string;
  stepName?: string;
  payload?: Record<string, unknown>;
}

const REGISTER_PATH = '/api/v1/workflows/local-run';

/**
 * Register the run and take its credential.
 *
 * The only call here that throws. Everything the mirror does afterwards
 * depends on this receipt, so a caller has to be able to tell "Cloud refused"
 * from "Cloud accepted" — and the CLI turns that difference into one line on
 * stderr rather than a failed run.
 */
export async function registerLocalRun(
  source: MirrorRunSource,
  options: CloudConnectionOptions = {},
): Promise<MirrorRegistration> {
  const result = await cloudFetch(REGISTER_PATH, options, {
    method: 'POST',
    detail: true,
    body: JSON.stringify({
      workflow: source.workflow,
      fileType: source.fileType,
      relayflowVersion: 'v2',
      ...(source.inputs === undefined ? {} : { inputs: source.inputs }),
    }),
  });
  if (!isCloudRecord(result)) {
    throw new CloudFlowError('invalid_response', 'Cloud did not return a registered local run.');
  }
  const runId = cloudRunId(result['runId']);
  const token = result['accessToken'];
  const callbackToken = result['callbackToken'];
  if (typeof token !== 'string' || token.trim().length === 0
    || typeof callbackToken !== 'string' || callbackToken.length === 0) {
    throw new CloudFlowError('invalid_response', 'Cloud registered the run without a usable credential.');
  }
  const { baseUrl } = cloudConnection(options);
  const runUrl = typeof result['runUrl'] === 'string' && /^https:\/\//u.test(result['runUrl'])
    ? result['runUrl']
    : `${baseUrl}/dashboard/workflow/${encodeURIComponent(runId)}/runner`;
  return { runId, token, callbackToken, runUrl, apiUrl: baseUrl };
}

/** A mirror's authenticated view of one run. Built once, from the registration. */
export class MirrorClient {
  /** Connection options with the run's credential and its deployment pinned. */
  private readonly bound: CloudConnectionOptions;

  constructor(
    private readonly registration: MirrorRegistration,
    options: CloudConnectionOptions = {},
  ) {
    this.bound = { ...options, token: registration.token, apiUrl: registration.apiUrl };
  }

  get runId(): string {
    return this.registration.runId;
  }

  get runUrl(): string {
    return this.registration.runUrl;
  }

  /**
   * Every call but registration goes through here. The run token replaces the
   * operator credential, the outcome collapses to a boolean, and nothing —
   * not a refusal, not a timeout, not a thrown transport error — escapes.
   */
  private async post(
    path: string,
    body: string,
    init: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<boolean> {
    try {
      await cloudFetch(path, {
        ...this.bound,
        ...(init.signal === undefined ? {} : { signal: init.signal }),
        ...(init.timeoutMs === undefined ? {} : { requestTimeoutMs: init.timeoutMs }),
      }, { method: 'POST', body });
      return true;
    } catch {
      return false;
    }
  }

  async publishEvent(event: MirrorEvent, signal?: AbortSignal): Promise<boolean> {
    return this.post(
      `/api/v1/workflows/runs/${this.registration.runId}/events`,
      JSON.stringify({
        eventType: event.eventType,
        ...(event.stepName === undefined ? {} : { stepName: event.stepName }),
        payload: event.payload ?? {},
      }),
      { ...(signal === undefined ? {} : { signal }) },
    );
  }

  async publishSnapshot(
    snapshot: { sequence: number; capturedAt: string; truncated?: true; omittedStepCount?: number; steps: SnapshotStep[] },
    limits: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<boolean> {
    return this.post(
      `/api/v1/workflows/runs/${this.registration.runId}/steps/snapshot`,
      JSON.stringify(snapshot),
      limits,
    );
  }

  async publishSteps(
    steps: readonly FinalStep[],
    omittedStepCount: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.post(
      `/api/v1/workflows/runs/${this.registration.runId}/steps`,
      JSON.stringify({ steps, ...(omittedStepCount > 0 ? { omittedStepCount } : {}) }),
      { ...(signal === undefined ? {} : { signal }) },
    );
  }

  /**
   * Write one object under the run's storage prefix. The keys are the ones the
   * `/logs` route already reads: `runner.log` for the run, and
   * `<stepName>/agent.log` for a step's assembled transcript.
   */
  async putObject(key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<boolean> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/u.test(key) || key.includes('..')) return false;
    try {
      await cloudFetch(
        `/api/v1/workflows/runs/${this.registration.runId}/storage/${key}`,
        { ...this.bound, ...(signal === undefined ? {} : { signal }) },
        { method: 'PUT', body: bytes, contentType: 'text/plain' },
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The terminal status. Authenticated by the callback token rather than the
   * run token, because that is the credential this route checks — and because
   * the run token is revoked by the transition this very call performs.
   */
  async reportTerminal(
    status: 'completed' | 'failed' | 'cancelled',
    result: Record<string, unknown>,
    error?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      await cloudFetch('/api/v1/workflows/callback', {
        ...this.bound,
        ...(signal === undefined ? {} : { signal }),
      }, {
        method: 'POST',
        body: JSON.stringify({
          runId: this.registration.runId,
          callbackToken: this.registration.callbackToken,
          status,
          result,
          ...(error === undefined ? {} : { error }),
        }),
      });
      return true;
    } catch {
      return false;
    }
  }
}
