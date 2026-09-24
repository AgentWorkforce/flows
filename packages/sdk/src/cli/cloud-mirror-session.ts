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
import { cloudConnection, CloudFlowError } from '../cloud-http.js';
import { recordMirroredRun, readMirroredRun } from '../cloud-mirror-ledger.js';
import { createRunMirror, readJournalEvents, type RunMirror } from '../cloud-mirror.js';
import { MirrorClient, registerLocalRun, type MirrorRunSource } from '../cloud-mirror-transport.js';
import { isAuthoredFlowPath, parseDirectInput } from '../direct-input.js';
import type { ProgressEvent } from '../progress.js';
import type { RunReport } from './run.js';

/** `FLOWS_CLOUD_MIRROR=0|false|off` turns the mirror off for a whole shell. */
export const MIRROR_ENV = 'FLOWS_CLOUD_MIRROR';

/** What the mirror knows about this run on Cloud, once it is registered. */
export interface CloudMirrorReceipt {
  /** Cloud's run id — the argument `flows status --cloud` and `flows logs` take. */
  cloudRunId: string;
  dashboardUrl: string;
}

export interface CloudMirrorSession {
  /** The root run is admitted: the mirror can start reading its journal. */
  onRunStarted(run: { runId: string }): void;
  /**
   * The registration, once it lands. Resolves to nothing when the mirror is
   * off, was refused, or the run never started.
   *
   * Awaiting it is what lets `--json` carry the same handle the terminal line
   * carries: registration is one request made when the run is admitted, so by
   * the time a run has a report it has long since settled — and a consumer of
   * a machine-readable report can wait for a request that has already
   * happened.
   */
  receipt(): Promise<CloudMirrorReceipt | undefined>;
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
  let receipt: CloudMirrorReceipt | undefined;

  const open = (runId: string): Promise<RunMirror | undefined> => opening ??= request.source(runId)
    .then(register)
    .then(registration => {
      const mirror = createMirror({
        client: new MirrorClient(registration),
        dataDir: request.dataDir,
        env,
        diagnostic: message => io.stderr(`[cloud] ${message}`),
      });
      receipt = { cloudRunId: registration.runId, dashboardUrl: registration.runUrl };
      // So a later `flows resume` of this same journal can name this attempt
      // as its predecessor. The credential is deliberately not written; a
      // resume mints its own.
      void recordMirroredRun(request.dataDir, runId, {
        cloudRunId: registration.runId, apiUrl: registration.apiUrl,
      });
      // The page, and the command that follows the same run from a terminal.
      // The id is Cloud's, not the journal's, and nothing else in this
      // invocation prints it — without it a reader has to pick it out of the
      // URL to use any of the hosted read verbs.
      io.stderr(`Dashboard: ${mirror.runUrl}  ·  flows status --cloud --watch ${registration.runId}`);
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
    async receipt() {
      if (opening === undefined) return undefined;
      await opening;
      return receipt;
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
        result: completionReport(report),
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
    // The predecessor, if this journal has been mirrored before. Read against
    // the deployment this invocation will actually register with, so a run
    // mirrored to staging never claims to continue an id that means something
    // else in production.
    const resumedFromRunId = await readMirroredRun(dataDir, runId, cloudConnection({}).baseUrl)
      .catch(() => undefined);
    // Through the retrying reader: a resume reads this journal while the
    // daemon is writing to it, and a single `journal_busy` used to abandon
    // the registration and leave the resumed run off the dashboard entirely.
    for (const event of await readJournalEvents(runId, dataDir)) {
      if (event.entry_type !== 'run.spawned') continue;
      const payload = event.payload as { spec?: unknown } | null;
      if (payload?.spec === undefined) break;
      return {
        workflow: canonicalize(payload.spec),
        fileType: 'yaml',
        ...(resumedFromRunId === undefined ? {} : { resumedFromRunId }),
      };
    }
    throw new CloudFlowError('invalid_input',
      `Run "${runId}" journals no spec to mirror; the run is unaffected.`);
  };
}

/** Diagnostics one completion report carries; the rest are counted. */
const MAX_REPORT_DIAGNOSTICS = 20;
/** One diagnostic message, in code points. */
const MAX_DIAGNOSTIC_CHARS = 2_000;

/**
 * The run's completion report, as the terminal callback stores it.
 *
 * Cloud reconciles a v2 run's reported status against this document: a
 * `completed` callback whose report does not carry `ok`, `status`,
 * `completionReason` and `runId` together is recorded as `failed`. That guard
 * exists so a sandbox whose bootstrap exits cleanly cannot report a run that
 * died at step 1 as green — and it cuts the other way too, so a mirror that
 * omits the report turns a finished local run red. Those four fields are the
 * contract; everything else here is what a reader of the run page gets for
 * free, since the run list extracts `completionReason` from the same document.
 *
 * Diagnostics are bounded and their messages clipped. They are the one part of
 * a report that is unbounded free text, and this document is stored whole.
 */
function completionReport(report: RunReport): Record<string, unknown> {
  const diagnostics = report.diagnostics.slice(0, MAX_REPORT_DIAGNOSTICS).map(entry => ({
    severity: 'severity' in entry ? entry.severity : 'refusal',
    kind: entry.kind,
    message: [...entry.message].slice(0, MAX_DIAGNOSTIC_CHARS).join(''),
  }));
  return {
    ok: report.ok,
    command: report.command,
    ...(report.runId === undefined ? {} : { runId: report.runId }),
    ...(report.rootRunId === undefined ? {} : { rootRunId: report.rootRunId }),
    ...(report.status === undefined ? {} : { status: report.status }),
    ...(report.completionReason === undefined ? {} : { completionReason: report.completionReason }),
    ...(report.completionDetail === undefined ? {} : { completionDetail: report.completionDetail }),
    ...(report.completedSteps === undefined ? {} : { completedSteps: report.completedSteps }),
    ...(report.parkedStep === undefined ? {} : { parkedStep: report.parkedStep }),
    ...(report.parkCause === undefined ? {} : { parkCause: report.parkCause }),
    ...(report.next === undefined ? {} : { next: report.next }),
    ...(diagnostics.length === 0 ? {} : { diagnostics }),
    ...(report.diagnostics.length > diagnostics.length
      ? { diagnosticsOmitted: report.diagnostics.length - diagnostics.length }
      : {}),
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
