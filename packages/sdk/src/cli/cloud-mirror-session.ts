// The Cloud half of `flows run` / `flows resume`: mirror this local run onto
// the dashboard, so a run started in a terminal is as watchable as one Cloud
// launched for you.
//
// On by default, and the default is conditional on exactly one thing: a Cloud
// credential this CLI can already resolve. A machine that has never run
// `agent-relay cloud login` has nothing to upload with, and refusing the run
// over that would be absurd — a local run that joins no workspace is not a
// defect (RFC-0001 settled decision 7; the journal is the record, and Cloud is
// one view onto it). So a missing login prints one line saying the run is
// local-only, and the run proceeds exactly as it always has.
//
// `--no-cloud-mirror` opts out, and `FLOWS_CLOUD_MIRROR=0` opts out for a
// whole shell — a CI job, a machine running someone else's flows, a checkout
// whose runs should not leave it.
//
// Best-effort throughout, like `observer-session.ts` beside it: registration
// failure is one labeled stderr line, and nothing here can change a run's
// exit code or its journal.

import { readFile } from 'node:fs/promises';
import type { CliIo } from '../cli.js';
import { canonicalize } from '../canonical.js';
import { CloudFlowError } from '../cloud-http.js';
import { createRunMirror, type RunMirror } from '../cloud-mirror.js';
import { MirrorClient, registerLocalRun, type MirrorRunSource } from '../cloud-mirror-transport.js';
import { isAuthoredFlowPath, parseDirectInput } from '../direct-input.js';
import { walkJournal } from '../journal-reader.js';
import type { ProgressEvent } from '../progress.js';
import type { RunReport } from './run.js';

/** `FLOWS_CLOUD_MIRROR=0|false|off` turns the mirror off for a whole shell. */
export const MIRROR_ENV = 'FLOWS_CLOUD_MIRROR';

export interface CloudMirrorSession {
  /** The root run is admitted: the mirror can start reading its journal. */
  onRunStarted(run: { runId: string }): void;
  /** A journaled entry; the first one names the run for a declarative flow. */
  onJournalEntry(entry: { run_id: string }): void;
  /** Step transitions, pushed as lifecycle events the run page's stream shows. */
  onProgress(event: ProgressEvent): void;
  /** Publish the final report and the terminal status. Never rejects. */
  finish(report: RunReport): Promise<void>;
}

export interface CloudMirrorDeps {
  register?: typeof registerLocalRun;
  createMirror?: typeof createRunMirror;
}

export interface CloudMirrorRequest {
  /**
   * The flow's source and input, exactly as `flows run --cloud` would send
   * them. Resolved lazily, once the run id exists: a `resume` has no flow
   * path at all and has to read what ran out of the journal.
   */
  source: (runId: string) => Promise<MirrorRunSource>;
  dataDir: string;
  /** Lines the CLI has printed for this run, uploaded as the run's `runner.log`. */
  log: () => readonly string[];
}

/** True unless the operator turned the mirror off for this shell. */
export function cloudMirrorEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env[MIRROR_ENV]?.trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off' && value !== 'no';
}

/**
 * Open the session. Registration is deferred until the run id exists, so a
 * refused flow never reaches Cloud at all: `flows run` on a spec that does not
 * compile creates no dashboard row, the same as today.
 */
export function createCloudMirrorSession(
  request: CloudMirrorRequest,
  io: CliIo,
  env: NodeJS.ProcessEnv = process.env,
  deps: CloudMirrorDeps = {},
): CloudMirrorSession {
  const register = deps.register ?? registerLocalRun;
  const createMirror = deps.createMirror ?? createRunMirror;
  let opening: Promise<RunMirror | undefined> | undefined;

  const open = (runId: string): Promise<RunMirror | undefined> => opening ??= request.source(runId)
    .then(register)
    .then(registration => {
      const mirror = createMirror({
        client: new MirrorClient(registration),
        dataDir: request.dataDir,
        env,
        diagnostic: message => io.stderr(`[cloud] ${message}`),
      });
      io.stderr(`Dashboard: ${mirror.runUrl}`);
      mirror.start(runId);
      return mirror;
    })
    .catch((error: unknown) => {
      io.stderr(`[cloud] ${mirrorRefusal(error)}`);
      return undefined;
    });

  return {
    onRunStarted(run) {
      void open(run.runId);
    },
    onJournalEntry(entry) {
      void open(entry.run_id);
    },
    onProgress(event) {
      // Fire-and-forget, and only for transitions: a `step.running` tick
      // arrives every second and would say nothing the snapshot does not.
      if (opening === undefined) return;
      if (event.type !== 'step.started' && event.type !== 'step.completed') return;
      void opening.then(mirror => mirror?.event({
        eventType: `relayflow.${event.type}`,
        stepName: event.stepId,
        payload: { stepType: event.stepType },
      }));
    },
    async finish(report) {
      const mirror = opening === undefined ? undefined : await opening;
      if (mirror === undefined) return;
      await mirror.finish({
        status: report.completionReason === 'canceled'
          ? 'cancelled'
          : report.ok ? 'completed' : 'failed',
        ...(report.completionReason === undefined ? {} : { completionReason: report.completionReason }),
        ...(terminalError(report) === undefined ? {} : { error: terminalError(report)! }),
        log: request.log(),
      });
    },
  };
}

/**
 * What `flows run` mirrors: the flow file's exact bytes, and — for an authored
 * flow — the input it was invoked with.
 *
 * The same source `flows run --cloud` would submit, so a run mirrored from a
 * terminal and the same run launched hosted are recorded identically. It is
 * read here rather than taken from the compiled spec because the compiled
 * form is not what the author wrote, and the run page shows source.
 */
export function mirrorSourceFromPath(
  path: string,
  inputArgument: string | undefined,
): () => Promise<MirrorRunSource> {
  return async () => {
    const workflow = await readFile(path, 'utf8');
    if (!isAuthoredFlowPath(path)) return { workflow, fileType: 'yaml' };
    return { workflow, fileType: 'ts', inputs: parseDirectInput(inputArgument) };
  };
}

/**
 * What `flows resume` mirrors: the kernel spec the journal recorded at
 * `run.spawned`, canonicalized.
 *
 * A resume names a run id, not a file — the flow it continues may have been
 * edited or deleted since. The journal is the record of what actually ran, so
 * that is what the mirror publishes, as canonical JSON (a YAML subset, the
 * same representation `runInCloud` sends for a declarative flow).
 *
 * Each resume registers its own Cloud run, and that is deliberate rather than
 * a shortcut: a mirrored run goes terminal on Cloud when the CLI exits, and
 * Cloud refuses to move a terminal run back to `running`. Cloud's own v2
 * resume is likewise a new attempt row, so one dashboard row per invocation is
 * the shape the control plane already has — and it costs no credential stored
 * on disk between invocations.
 */
export function mirrorSourceFromJournal(dataDir: string): (runId: string) => Promise<MirrorRunSource> {
  return async (runId) => {
    for await (const event of walkJournal(runId, dataDir)) {
      if (event.entry_type !== 'run.spawned') continue;
      const payload = event.payload as { spec?: unknown } | null;
      if (payload?.spec === undefined) break;
      return { workflow: canonicalize(payload.spec), fileType: 'yaml' };
    }
    throw new CloudFlowError('invalid_input',
      `Run "${runId}" journals no spec to mirror; the run is unaffected.`);
  };
}

/**
 * Why the mirror is not running, in one line a reader can act on.
 *
 * A missing login is the ordinary case and reads as a fact plus the command
 * that changes it — never as an error, because a local-only run is not one.
 */
function mirrorRefusal(error: unknown): string {
  if (error instanceof CloudFlowError && error.code === 'configuration') {
    return error.reason === 'auth_missing'
      ? 'no Cloud login, so this run stays local. `agent-relay cloud login` puts future runs on the dashboard; '
        + `${MIRROR_ENV}=0 stops this line.`
      : `this run stays local: ${error.message}`;
  }
  if (error instanceof CloudFlowError && error.status === 404) {
    return 'this Cloud deployment does not accept local runs yet; the run is unaffected';
  }
  return `could not register this run with Cloud, so it stays local (${
    error instanceof Error ? error.message : String(error)}); the run is unaffected`;
}

/** The run's own failure text, bounded by the mirror's transport, or nothing. */
function terminalError(report: RunReport): string | undefined {
  if (report.ok) return undefined;
  const diagnostic = report.diagnostics.find(entry =>
    'severity' in entry && (entry.severity === 'failure' || entry.severity === 'refusal'));
  return diagnostic?.message;
}
