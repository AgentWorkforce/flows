/**
 * The observer half of `flows run` / `flows resume`: once the run id is known,
 * project the run into its `wf-<runId>` channel and mint a read-only link
 * scoped to that channel, so the link opens on this run's step graph instead
 * of an arbitrary workspace channel. The link is printed on stderr the moment
 * it exists, so a human can follow the run live, and again after `RUN`.
 *
 * Best-effort throughout: no workspace key means no session, and a projection
 * or mint failure is a labeled stderr line. The run never depends on it.
 */

import type { CliIo } from '../cli.js';
import { createJournalProjector } from '../journal-projection.js';
import type { JournalEvent } from '../journal-reader.js';
import { mintObserverUrl, resolveObserverLinkEnv, type MintObserverOptions } from '../observer-link.js';
import type { ProgressEvent } from '../progress.js';
import {
  createRunProjection, runChannelName, type DeclaredStep, type ProjectionFetch, type RunProjection,
} from '../run-projection.js';
import type { RunReport } from './run.js';

type MintOutcome = { observerUrl?: string; warning?: string };

/** Bounded so an unreachable Relaycast cannot hold the CLI open. */
const DRAIN_GRACE_MS = 5_000;

export interface ObserverSession {
  /** YAML runs: every entry `run.start {watch}` / `run.watch` pushes. */
  onJournalEntry(entry: JournalEvent): void;
  /** Authored runs: the root's id and name, known once it is admitted. */
  onRunStarted(run: { runId: string; flow: string; resumed?: boolean }): void;
  /** Authored runs: step transitions from the body's executor. */
  onProgress(event: ProgressEvent): void;
  /** Close the projection from the final report and settle the link. */
  finish(report: RunReport): Promise<MintOutcome> | undefined;
}

export interface ObserverSessionDeps {
  fetch?: ProjectionFetch;
  mint?: (options: MintObserverOptions) => Promise<MintOutcome>;
}

export function createObserverSession(
  command: 'run' | 'resume',
  io: CliIo,
  env: NodeJS.ProcessEnv = process.env,
  deps: ObserverSessionDeps = {},
): ObserverSession | undefined {
  const link = resolveObserverLinkEnv(env);
  if (link.suppressed || link.workspaceKey === undefined) return undefined;
  const workspaceKey = link.workspaceKey;
  const mint = deps.mint ?? mintObserverUrl;
  const liveSinceMs = command === 'resume' ? Date.now() : 0;
  let projection: RunProjection | undefined;
  let minted: Promise<MintOutcome> | undefined;
  let rootRunId: string | undefined;

  const mintFor = (runId: string): Promise<MintOutcome> => minted ??= mint({
    workspaceKey,
    channel: runChannelName(runId),
    ...(link.baseUrl === undefined ? {} : { baseUrl: link.baseUrl }),
    ...(link.dashboardUrl === undefined ? {} : { dashboardUrl: link.dashboardUrl }),
  }).catch((error: unknown) => ({ warning: error instanceof Error ? error.message : 'unknown mint error' }));

  const open = (run: { runId: string; flow: string; steps?: DeclaredStep[]; resumed?: boolean }): RunProjection => {
    if (projection !== undefined) return projection;
    rootRunId = run.runId;
    projection = createRunProjection({
      workspaceKey,
      ...(link.baseUrl === undefined ? {} : { baseUrl: link.baseUrl }),
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      diagnostic: message => io.stderr(`[observer] ${message}`),
    }, run);
    void mintFor(run.runId).then(outcome => {
      if (outcome.observerUrl !== undefined) io.stderr(`Observer: ${outcome.observerUrl}`);
    });
    return projection;
  };
  const project = createJournalProjector(
    run => open({ ...run, ...(liveSinceMs > 0 ? { resumed: true } : {}) }), liveSinceMs,
  );

  return {
    onJournalEntry(entry) {
      try { project(entry); } catch (error) {
        io.stderr(`[observer] could not project journal entry ${entry.seq}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    onRunStarted: run => { open(run); },
    onProgress(event) { projection?.step(event); },
    finish(report) {
      const runId = rootRunId ?? report.runId;
      if (runId === undefined) return undefined;
      if (projection === undefined) {
        io.stderr('[observer] this run was not projected (the daemon did not stream its journal); '
          + 'the observer link opens an empty channel');
      }
      projection?.finish({
        status: report.status === 'parked' ? 'parked' : report.completionReason === 'canceled' ? 'canceled'
          : report.ok ? 'completed' : 'failed',
        ...(report.completionReason === undefined ? {} : { completionReason: report.completionReason }),
      });
      const drained = projection?.close(DRAIN_GRACE_MS) ?? Promise.resolve();
      return drained.then(() => mintFor(runId));
    },
  };
}
