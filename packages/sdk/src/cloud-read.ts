// Reading a hosted run: the four Cloud GETs behind `flows runs`, `flows logs`
// and `flows status --cloud`.
//
// Nothing here writes. Every call goes through `cloudFetch`, so the credential
// is resolved exactly once and in exactly one place (cloud-http.ts: the `token`
// option, then `FLOWS_CLOUD_TOKEN`, then the `agent-relay cloud login` store,
// with the URL binding and the expiry refusal) -- an agent inspecting its own
// runs holds the same credential it would use to start one, and there is no
// second path to get it wrong.
//
// The routes answer Cloud's own field names in camelCase. This module is where
// they become the snake_case view the SDK renders, so the shape a reader sees
// is the SDK's and a Cloud response field that changes name breaks here rather
// than in three renderers. Every field is read defensively: a route that adds a
// key is ignored, a route that drops one yields `null`, never a throw.

import { CloudFlowError, cloudFetch, cloudRunId, isCloudRecord, type CloudConnectionOptions } from './cloud-http.js';

/** One row of `GET /api/v1/workflows/runs`. */
export interface CloudRunSummary {
  run_id: string;
  /** The flow's declared name, read out of the bounded `workflow` projection. */
  name: string;
  status: string;
  /** Present on a parked or finished run; the list extracts it from `result`. */
  completion_reason: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** Only a literal GitHub pull request URL survives; anything else is dropped. */
  pull_request_url: string | null;
  /** The bounded error preview the list carries, redacted by the caller. */
  error: string | null;
}

/** `GET /api/v1/workflows/runs/<runId>` -- the run record itself. */
export interface CloudRunDetail {
  run_id: string;
  name: string;
  status: string;
  completion_reason: string | null;
  created_at: string | null;
  updated_at: string | null;
  pull_request_url: string | null;
  error: string | null;
  completed_steps: number | null;
  /** What Cloud pinned to execute this run; provenance, not state. */
  authority: {
    surface_version: string | null;
    source_sha256: string | null;
    artifact_sha256: string | null;
    source_commit: string | null;
  } | null;
}

/** One entry of a step's `detail.attempts`. */
export interface CloudStepAttempt {
  attempt: number | null;
  disposition: string | null;
  completion_reason: string | null;
  at_ms: number | null;
  transcript_bytes: number | null;
}

/** One tool the agent used, from the digest's `tools.counts`. */
export interface CloudToolCount {
  name: string;
  calls: number | null;
  errors: number | null;
}

/** One of the digest's `tools.last_calls`. */
export interface CloudToolCall {
  seq: number | null;
  name: string;
  result_bytes: number | null;
  input_excerpt: string | null;
}

/**
 * The transcript digest flows 2.0.22 ships on each agent step
 * (`detail.transcript`). The same facts the local `flows status` prints from
 * the journal's `trajectory_tail.transcript`, plus the tool roster Cloud keeps.
 */
export interface CloudStepTranscript {
  attempt: number | null;
  model: string | null;
  num_turns: number | null;
  total_cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read: number | null;
  cache_creation: number | null;
  duration_ms: number | null;
  subtype: string | null;
  is_error: boolean;
  exit_code: number | null;
  bytes_kept: number | null;
  bytes_total: number | null;
  frames_kept: number | null;
  frames_total: number | null;
  truncated: boolean;
  total_calls: number | null;
  tools: CloudToolCount[];
  last_calls: CloudToolCall[];
  artifacts: string[];
  artifact_count: number | null;
}

/** One row of `GET /api/v1/workflows/runs/<runId>/steps`. */
export interface CloudStep {
  step_name: string;
  step_type: string;
  status: string;
  completion_reason: string | null;
  cli: string | null;
  model: string | null;
  /** The log selector: `flows logs <run> --step <sandbox_id>`. Empty for a non-agent step. */
  sandbox_id: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  retry_count: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  output_summary: string | null;
  gate: { gate: string; verdict: string; detail: string } | null;
  attempts: CloudStepAttempt[];
  transcript: CloudStepTranscript | null;
}

/** `GET /api/v1/workflows/runs/<runId>/logs` -- the route's own envelope. */
export interface CloudRunLog {
  content: string;
  /** Byte offset the content ends at; the route serves from `?offset=`. */
  offset: number;
  total_size: number;
  /** False while the run is still producing; the content so far is still whole. */
  done: boolean;
}

/** What `listCloudRuns` returns: the page, and whether `limit` cut it short. */
export interface CloudRunList {
  runs: CloudRunSummary[];
  /** True when Cloud had more rows than `limit` asked for. */
  more: boolean;
}

/** A step name that can safely ride in a query string, and is worth asking about. */
const STEP_NAME = /^[^\u0000-\u001F\u007F]{1,200}$/u;

function get(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return isCloudRecord(value) ? value : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The flow's name out of the bounded `workflow` projection.
 *
 * The list route ships `workflow` as a JSON *string* -- either a two-field
 * object the SQL built (`{"name": ..., "description": ...}`) or, for a
 * non-JSON source, a 4 KiB prefix of the source itself. Parsing is therefore
 * allowed to fail, and a failure is not an error: the row is still a run, it
 * just has no declared name to show.
 */
function workflowName(value: unknown): string {
  const raw = str(value);
  if (raw === null) return 'unnamed';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'unnamed';
  }
  const object = record(parsed);
  return object === null ? 'unnamed' : str(get(object, 'name')) ?? 'unnamed';
}

/**
 * Only a literal GitHub pull request URL is surfaced.
 *
 * `pullRequestUrl` is whatever the run's callback put in `result`, which is
 * flow-authored text. Cloud's own render layer applies this same constraint
 * (`runPullRequestUrl` in lib/workflows/parked-run.ts); a CLI that printed the
 * raw field would be a clickable line an authored flow controls.
 */
function pullRequestUrl(value: unknown): string | null {
  const raw = str(value);
  if (raw === null) return null;
  return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/u.test(raw) ? raw : null;
}

function runSummary(row: Record<string, unknown>): CloudRunSummary | null {
  const runId = str(get(row, 'runId'));
  if (runId === null) return null;
  return {
    run_id: runId,
    name: workflowName(get(row, 'workflow')),
    status: str(get(row, 'status')) ?? 'unknown',
    completion_reason: str(get(row, 'completionReason')),
    created_at: str(get(row, 'createdAt')),
    updated_at: str(get(row, 'updatedAt')),
    pull_request_url: pullRequestUrl(get(row, 'pullRequestUrl')),
    error: str(get(row, 'error')),
  };
}

/**
 * Recent runs the token can see, newest first.
 *
 * The route pages by opaque cursor and has no `limit` parameter (a page is
 * `RUN_LIST_PAGE_SIZE` = 100 rows), so `limit` is honoured here: pages are
 * followed only while fewer than `limit` rows are in hand, and `more` reports
 * whether Cloud had further rows. A caller asking for 10 makes exactly one
 * request.
 */
export async function listCloudRuns(
  limit: number,
  options: CloudConnectionOptions = {},
): Promise<CloudRunList> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new CloudFlowError('invalid_input', 'runs --limit must be an integer between 1 and 1000.');
  }
  const runs: CloudRunSummary[] = [];
  let cursor: string | null = null;
  let more = false;
  // Bounded by `limit`, and by the page size: a thousand rows is ten requests.
  for (;;) {
    const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    const body = record(await cloudFetch(`/api/v1/workflows/runs${query}`, options, { method: 'GET', detail: true }));
    if (body === null) throw new CloudFlowError('invalid_response', 'Cloud returned no run list.');
    for (const row of array(get(body, 'runs'))) {
      const parsed = record(row) === null ? null : runSummary(record(row)!);
      if (parsed === null) continue;
      if (runs.length === limit) { more = true; break; }
      runs.push(parsed);
    }
    cursor = str(get(body, 'nextCursor'));
    if (runs.length >= limit) { more = more || cursor !== null; break; }
    if (cursor === null) break;
  }
  return { runs, more };
}

function authority(value: unknown): CloudRunDetail['authority'] {
  const object = record(value);
  if (object === null) return null;
  const source = record(get(object, 'source'));
  const artifact = record(get(object, 'artifact'));
  const surface = source === null ? null : record(get(source, 'surface'));
  return {
    surface_version: surface === null ? null : str(get(surface, 'version')),
    source_sha256: source === null ? null : str(get(source, 'sha256')),
    artifact_sha256: artifact === null ? null : str(get(artifact, 'sha256')),
    source_commit: artifact === null ? null : str(get(artifact, 'sourceCommit')),
  };
}

/** One hosted run's record. */
export async function getCloudRunDetail(
  runId: string,
  options: CloudConnectionOptions = {},
): Promise<CloudRunDetail> {
  const body = record(await cloudFetch(`/api/v1/workflows/runs/${cloudRunId(runId)}`, options,
    { method: 'GET', detail: true }));
  if (body === null) throw new CloudFlowError('invalid_response', 'Cloud returned no run record.');
  const result = record(get(body, 'result'));
  return {
    run_id: str(get(body, 'runId')) ?? runId,
    name: workflowName(get(body, 'workflow')),
    status: str(get(body, 'status')) ?? 'unknown',
    // On the detail route the reason is inside the run's `result`, not lifted
    // into a column the way the list's SQL lifts it.
    completion_reason: result === null ? null : str(get(result, 'completionReason')),
    created_at: str(get(body, 'createdAt')),
    updated_at: str(get(body, 'updatedAt')),
    pull_request_url: result === null ? null : pullRequestUrl(get(result, 'pullRequestUrl')),
    error: str(get(body, 'error')),
    completed_steps: result === null ? null : num(get(result, 'completedSteps')),
    authority: authority(get(body, 'relayflowV2Authority')),
  };
}

function transcript(value: unknown): CloudStepTranscript | null {
  const object = record(value);
  if (object === null) return null;
  const file = record(get(object, 'file'));
  const tools = record(get(object, 'tools'));
  const result = record(get(object, 'result'));
  const usage = result === null ? null : record(get(result, 'usage'));
  const artifacts = record(get(object, 'artifacts'));
  return {
    attempt: num(get(object, 'attempt')),
    model: result === null ? null : str(get(result, 'model')),
    num_turns: result === null ? null : num(get(result, 'num_turns')),
    total_cost_usd: result === null ? null : num(get(result, 'total_cost_usd')),
    tokens_in: usage === null ? null : num(get(usage, 'input')),
    tokens_out: usage === null ? null : num(get(usage, 'output')),
    cache_read: usage === null ? null : num(get(usage, 'cache_read')),
    cache_creation: usage === null ? null : num(get(usage, 'cache_creation')),
    duration_ms: result === null ? null : num(get(result, 'duration_ms')),
    subtype: result === null ? null : str(get(result, 'subtype')),
    is_error: result !== null && get(result, 'is_error') === true,
    exit_code: num(get(object, 'exit_code')),
    bytes_kept: file === null ? null : num(get(file, 'bytes_kept')),
    bytes_total: file === null ? null : num(get(file, 'bytes_total')),
    frames_kept: file === null ? null : num(get(file, 'frames_kept')),
    frames_total: file === null ? null : num(get(file, 'frames_total')),
    truncated: file !== null && get(file, 'truncated') === true,
    total_calls: tools === null ? null : num(get(tools, 'total_calls')),
    tools: tools === null ? [] : array(get(tools, 'counts')).flatMap((entry) => {
      const count = record(entry);
      const name = count === null ? null : str(get(count, 'name'));
      return name === null ? [] : [{ name, calls: num(get(count!, 'calls')), errors: num(get(count!, 'errors')) }];
    }),
    last_calls: tools === null ? [] : array(get(tools, 'last_calls')).flatMap((entry) => {
      const call = record(entry);
      const name = call === null ? null : str(get(call, 'name'));
      return name === null ? [] : [{
        name,
        seq: num(get(call!, 'seq')),
        result_bytes: num(get(call!, 'result_bytes')),
        input_excerpt: str(get(call!, 'input_excerpt')),
      }];
    }),
    artifacts: artifacts === null ? [] : array(get(artifacts, 'paths')).flatMap((path) => {
      const text = str(path);
      return text === null ? [] : [text];
    }),
    artifact_count: artifacts === null ? null : num(get(artifacts, 'count')),
  };
}

function step(row: Record<string, unknown>): CloudStep | null {
  const name = str(get(row, 'stepName'));
  if (name === null) return null;
  const detail = record(get(row, 'detail'));
  const verification = detail === null ? null : record(get(detail, 'verification'));
  return {
    step_name: name,
    step_type: str(get(row, 'stepType')) ?? 'unknown',
    status: str(get(row, 'status')) ?? 'unknown',
    completion_reason: str(get(row, 'completionReason')),
    cli: str(get(row, 'cli')),
    model: str(get(row, 'model')),
    sandbox_id: str(get(row, 'sandboxId')) ?? '',
    started_at: str(get(row, 'startTime')),
    ended_at: str(get(row, 'endTime')),
    // `wallclockMs` is the kernel's own measure; `durationMs` is Cloud's
    // subtraction of the two timestamps. Prefer the kernel's when it is there.
    duration_ms: (detail === null ? null : num(get(detail, 'wallclockMs'))) ?? num(get(row, 'durationMs')),
    exit_code: num(get(row, 'exitCode')),
    retry_count: num(get(row, 'retryCount')),
    tokens_in: num(get(row, 'tokensInput')),
    tokens_out: num(get(row, 'tokensOutput')),
    cost_usd: num(get(row, 'costUsd')),
    output_summary: str(get(row, 'outputSummary')),
    gate: verification === null ? null : {
      gate: str(get(verification, 'gate')) ?? 'unknown',
      verdict: str(get(verification, 'verdict')) ?? 'unknown',
      detail: str(get(verification, 'detail')) ?? '',
    },
    attempts: detail === null ? [] : array(get(detail, 'attempts')).flatMap((entry) => {
      const attempt = record(entry);
      return attempt === null ? [] : [{
        attempt: num(get(attempt, 'attempt')),
        disposition: str(get(attempt, 'disposition')),
        completion_reason: str(get(attempt, 'completionReason')),
        at_ms: num(get(attempt, 'atMs')),
        transcript_bytes: num(get(attempt, 'transcriptBytes')),
      }];
    }),
    transcript: detail === null ? null : transcript(get(detail, 'transcript')),
  };
}

/** One hosted run's per-step rows, in execution order. */
export async function getCloudRunSteps(
  runId: string,
  options: CloudConnectionOptions = {},
): Promise<CloudStep[]> {
  const body = record(await cloudFetch(`/api/v1/workflows/runs/${cloudRunId(runId)}/steps`, options,
    { method: 'GET', detail: true }));
  if (body === null) throw new CloudFlowError('invalid_response', 'Cloud returned no step list.');
  return array(get(body, 'steps')).flatMap((row) => {
    const parsed = record(row);
    const built = parsed === null ? null : step(parsed);
    return built === null ? [] : [built];
  });
}

/**
 * The runner log, or one step's agent transcript.
 *
 * With no `step` this is the sandbox's own runner output. With one it is that
 * step's transcript as JSONL -- the route keys it by the step's `sandboxId`,
 * which for an agent step is the step name.
 *
 * One request: the route serves from `offset` to the end with no chunk cap, so
 * there is no loop here and nothing polls. `done: false` means the run is
 * still producing, and the caller is told rather than made to wait.
 */
export async function getCloudRunLog(
  runId: string,
  step: string | undefined,
  options: CloudConnectionOptions = {},
): Promise<CloudRunLog> {
  if (step !== undefined && !STEP_NAME.test(step)) {
    throw new CloudFlowError('invalid_input', 'A step name must be 1-200 characters and carry no control characters.');
  }
  const query = step === undefined ? '' : `?sandboxId=${encodeURIComponent(step)}`;
  const body = record(await cloudFetch(`/api/v1/workflows/runs/${cloudRunId(runId)}/logs${query}`, options,
    { method: 'GET', detail: true }));
  if (body === null) throw new CloudFlowError('invalid_response', 'Cloud returned no log envelope.');
  const content = get(body, 'content');
  if (typeof content !== 'string') throw new CloudFlowError('invalid_response', 'Cloud log envelope carried no content.');
  return {
    content,
    offset: num(get(body, 'offset')) ?? content.length,
    total_size: num(get(body, 'totalSize')) ?? content.length,
    done: get(body, 'done') === true,
  };
}
