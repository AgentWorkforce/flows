// `flows runs`, `flows logs` and `flows status --cloud` against a fake Cloud.
//
// The fixtures are the shapes production answered on 2026-09-19 for run
// 20d04c99-3fa8-48c9-9286-92d364a5bc2e, trimmed: a three-step run whose middle
// step is an agent with a seven-frame transcript. Anything these tests assert
// about a field name is a field name the real routes emit.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import {
  errorLines, parseLogsArgs, parseRunsArgs, runCloudLogsCli, runCloudRunsCli, runCloudStatusCli,
} from '../src/cli/cloud-read.js';
import { renderStepEvidence, stepFailureDetails } from '../src/cli/step-failure.js';
import { parseStatusArgs } from '../src/cli/status.js';
import type { JournalClient } from '../src/journal-client.js';

const RUN = '20d04c99-3fa8-48c9-9286-92d364a5bc2e';
const CONNECTION = { apiUrl: 'https://cloud-contract.example', token: 'test-scoped-cloud-token', env: {} };

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-read-'));
  directories.push(directory);
  return directory;
}

interface Answer { status?: number; body: unknown }

/**
 * A fake Cloud. The handler sees the path and the query exactly as the SDK
 * built them, so a test can assert the route and the parameters as well as the
 * render — `?sandboxId=` is part of the contract, not an implementation detail.
 */
function cloud(handler: (path: string, query: URLSearchParams, auth: string | undefined) => Answer): {
  requests: Array<{ path: string; query: string; auth: string | undefined }>;
} {
  const requests: Array<{ path: string; query: string; auth: string | undefined }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get('authorization') ?? undefined;
    requests.push({ path: url.pathname, query: url.search, auth });
    const answer = handler(url.pathname, url.searchParams, auth);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200, headers: { 'content-type': 'application/json' },
    });
  });
  return { requests };
}

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) } };
}

function runRow(runId: string, overrides: Record<string, unknown> = {}) {
  return {
    runId, userId: 'user-1', workspaceId: 'workspace-1', sandboxId: 'sandbox-1',
    dispatchType: 'sandbox', relayflowVersion: 'v2', fileType: 'ts', status: 'completed',
    createdAt: '2026-09-19T20:34:58.286000Z', updatedAt: '2026-09-19T20:37:42.963Z',
    workflow: '{"name" : "insight-proof-2022", "description" : null}',
    error: null, completionReason: 'success', pullRequestUrl: null,
    ...overrides,
  };
}

const RUN_DETAIL = {
  runId: RUN, sandboxId: '583c2b2b-7010-4517-a791-06f4c3751de6', dispatchType: 'sandbox', relayflowVersion: 'v2',
  relayflowV2Authority: {
    source: { sha256: 'ecc258052a37508b8fc217b36fb0a163331a55f88c53d6e915f8ef3e4135efb7', surface: { version: '2.0.22' } },
    artifact: { sha256: '9c361a2cbb0aa051505c3b2a2b715970c69a6ffa548cf1e48452677ba057359a', sourceCommit: 'b4dd665eb433bd7f52d1045543aef5f14fb7891e' },
  },
  workflow: '{"schemaVersion":1,"name":"insight-proof-2022","inputPresent":true,"input":{}}',
  fileType: 'ts', status: 'completed',
  createdAt: '2026-09-19T20:34:58.286Z', updatedAt: '2026-09-19T20:37:42.963Z',
  result: { ok: true, command: 'run', completedSteps: 3, status: 'completed', completionReason: 'success' },
};

const STEPS = {
  steps: [
    {
      stepName: 'run-1', agent: 'deterministic', preset: 'deterministic', cli: 'shell', sandboxId: '',
      startTime: '2026-09-19T20:37:21.163Z', endTime: '2026-09-19T20:37:21.166Z', durationMs: 3, exitCode: 0,
      outputSummary: 'step completed: success', status: 'completed', stepType: 'deterministic',
      completionReason: 'success', retryCount: 0, tokensInput: 0, tokensOutput: 0,
      detail: {
        attempts: [{ atMs: 1789850241163, attempt: 1, disposition: 'step_done', completionReason: 'success' }],
        wallclockMs: 3, verification: { gate: 'exit_code', detail: 'all gates passed', verdict: 'pass' },
      },
    },
    {
      stepName: 'agent-2', agent: 'agent-2', preset: 'claude-opus-5', cli: 'claude', sandboxId: 'agent-2',
      startTime: '2026-09-19T20:37:24.451Z', endTime: '2026-09-19T20:37:33.703Z', durationMs: 9252, exitCode: 0,
      outputSummary: '**Middle word:** `beta`', status: 'completed', stepType: 'agent',
      completionReason: 'success', retryCount: 0, model: 'claude-opus-5',
      tokensInput: 4, tokensOutput: 248, costUsd: 0.10809810000000002,
      detail: {
        attempts: [{ atMs: 1789850244451, attempt: 1, disposition: 'step_done', transcriptBytes: 5873, completionReason: 'success' }],
        transcript: {
          file: { sha256: 'aa', truncated: false, bytes_kept: 5873, bytes_total: 5873, frames_kept: 7, frames_total: 7 },
          tools: {
            counts: [{ name: 'Read', calls: 1, errors: 0 }], complete: true,
            last_calls: [{ seq: 1, name: 'Read', result_bytes: 393, input_excerpt: '{"file_path":"/project/notes.txt"}' }],
            shown_calls: 1, total_calls: 1,
          },
          result: {
            model: 'claude-opus-5', usage: { input: 4, output: 248, cache_read: 25402, cache_creation: 25638 },
            subtype: 'success', is_error: false, provider: 'claude', num_turns: 2,
            session_id: '4076fae9', duration_ms: 6189, total_cost_usd: 0.10809810000000002,
            claude_code_version: '2.1.19',
          },
          attempt: 1, artifacts: { count: 0, paths: [] }, exit_code: 0,
        },
        wallclockMs: 9252, verification: { gate: 'completion', detail: 'all gates passed', verdict: 'pass' },
      },
    },
    {
      stepName: 'complete-3', agent: 'deterministic', preset: 'deterministic', cli: 'shell', sandboxId: '',
      startTime: '2026-09-19T20:37:33.737Z', endTime: '2026-09-19T20:37:33.738Z', durationMs: 1, exitCode: 0,
      outputSummary: 'step completed: success', status: 'completed', stepType: 'deterministic',
      completionReason: 'success', retryCount: 0, tokensInput: 0, tokensOutput: 0,
      detail: {
        attempts: [{ atMs: 1789850253737, attempt: 1, disposition: 'step_done', completionReason: 'success' }],
        wallclockMs: 1, verification: { gate: 'exit_code', detail: 'all gates passed', verdict: 'pass' },
      },
    },
  ],
};

const TRANSCRIPT = [
  '{"type":"relayflow.attempt","attempt":1,"bytes":5873,"truncated":false}',
  '{"relayflow_reduced":true,"type":"system","subtype":"init","model":"claude-opus-5","claude_code_version":"2.1.19",'
    + '"permissionMode":"bypassPermissions","session_id":"4076fae9","tools_count":18,"mcp_servers_count":0}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I\'ll read the file."}]}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Read",'
    + '"input":{"file_path":"/project/notes.txt"}}]}}',
  '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result",'
    + '"content":"     1→alpha\\n     2→beta\\n"}]}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hm","signature":"CAIS"}]}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"**Middle word:** `beta`"}]}}',
  '{"type":"result","subtype":"success","is_error":false,"duration_ms":6189,"num_turns":2,'
    + '"total_cost_usd":0.10809810000000002,"usage":{"input_tokens":4,"output_tokens":248,'
    + '"cache_read_input_tokens":25402,"cache_creation_input_tokens":25638}}',
  '',
].join('\n');

const RUNNER_LOG = '[bootstrap] Starting workflow execution (per-step-sandbox)\n'
  + '[relayflow-v2] {"event":"workflow.completed","workflow":"insight-proof-2022","steps":3}\n';

function logEnvelope(content: string) {
  return { content, offset: content.length, totalSize: content.length, done: true };
}

/** The whole surface, answering the four routes the way production does. */
function wholeCloud(overrides: { transcript?: string; runner?: string; runs?: unknown[] } = {}) {
  return cloud((path, query) => {
    if (path === '/api/v1/workflows/runs') {
      return { body: { runs: overrides.runs ?? [runRow(RUN)], nextCursor: null } };
    }
    if (path === `/api/v1/workflows/runs/${RUN}`) return { body: RUN_DETAIL };
    if (path === `/api/v1/workflows/runs/${RUN}/steps`) return { body: STEPS };
    if (path === `/api/v1/workflows/runs/${RUN}/logs`) {
      const sandbox = query.get('sandboxId');
      if (sandbox === null) return { body: logEnvelope(overrides.runner ?? RUNNER_LOG) };
      if (sandbox === 'agent-2') return { body: logEnvelope(overrides.transcript ?? TRANSCRIPT) };
      // Production answers 200-with-nothing for a sandbox id it does not know.
      return { body: { content: '', offset: 0, totalSize: 0, done: true } };
    }
    return { status: 404, body: { error: 'Run not found' } };
  });
}

describe('flows runs', () => {
  it('lists recent runs with status, reason, name, timestamps and the PR when there is one', async () => {
    const server = wholeCloud({
      runs: [
        runRow(RUN, { pullRequestUrl: 'https://github.com/AgentWorkforce/flows/pull/12' }),
        runRow('9829b3a3-7c83-52bc-b6b8-34adfafb51d1', {
          status: 'failed', completionReason: null, error: 'Relayflow v2 CLI failed with exit code 1',
        }),
      ],
    });
    const out = io();
    const code = await runCloudRunsCli(parseRunsArgs(['--limit', '5'])!, out.io, CONNECTION);
    expect(code).toBe(0);
    expect(out.stderr).toEqual([]);
    expect(out.stdout[0]).toBe('runs 2');
    expect(out.stdout[1]).toContain(RUN);
    expect(out.stdout[1]).toContain('insight-proof-2022');
    expect(out.stdout[1]).toContain('completed');
    expect(out.stdout[1]).toContain('success');
    expect(out.stdout[1]).toContain('started 2026-09-19T20:34:58Z');
    expect(out.stdout[1]).toContain('updated 2026-09-19T20:37:42Z');
    expect(out.stdout[2]).toBe('      pr https://github.com/AgentWorkforce/flows/pull/12');
    expect(out.stdout[3]).toContain('failed');
    expect(out.stdout.at(-2)).toBe('      error');
    expect(out.stdout.at(-1)).toBe('        Relayflow v2 CLI failed with exit code 1');
    expect(server.requests).toEqual([{ path: '/api/v1/workflows/runs', query: '', auth: 'Bearer test-scoped-cloud-token' }]);
  });

  it('honours --limit across the route’s cursor pages and says when more remain', async () => {
    const server = cloud((path, query) => {
      expect(path).toBe('/api/v1/workflows/runs');
      const page = query.get('cursor');
      return page === null
        ? { body: { runs: [runRow('run-a'), runRow('run-b')], nextCursor: 'cursor-2' } }
        : { body: { runs: [runRow('run-c')], nextCursor: null } };
    });
    const out = io();
    expect(await runCloudRunsCli({ command: 'runs', limit: 3, json: false }, out.io, CONNECTION)).toBe(0);
    expect(out.stdout[0]).toBe('runs 3');
    expect(server.requests.map((request) => request.query)).toEqual(['', '?cursor=cursor-2']);

    const bounded = io();
    cloud(() => ({ body: { runs: [runRow('run-a'), runRow('run-b')], nextCursor: 'cursor-2' } }));
    expect(await runCloudRunsCli({ command: 'runs', limit: 1, json: false }, bounded.io, CONNECTION)).toBe(0);
    expect(bounded.stdout[0]).toBe('runs 1 (more available; pass --limit)');
  });

  it('emits one canonical JSON object under --json', async () => {
    wholeCloud();
    const out = io();
    expect(await runCloudRunsCli(parseRunsArgs(['--json'])!, out.io, CONNECTION)).toBe(0);
    expect(out.stdout).toHaveLength(1);
    expect(JSON.parse(out.stdout[0]!)).toMatchObject({
      v: 1, ok: true, more: false,
      runs: [{ run_id: RUN, name: 'insight-proof-2022', status: 'completed', completion_reason: 'success' }],
    });
  });

  it('shows a run whose workflow projection is not JSON as unnamed rather than dumping the source', async () => {
    wholeCloud({ runs: [runRow(RUN, { workflow: 'name: legacy-yaml-flow\nsteps:\n  - id: one\n' })] });
    const out = io();
    await runCloudRunsCli({ command: 'runs', limit: 5, json: false }, out.io, CONNECTION);
    expect(out.stdout[1]).toContain('unnamed');
    expect(out.stdout.join('\n')).not.toContain('steps:');
  });

  it('drops a pullRequestUrl that is not literally a GitHub pull request URL', async () => {
    wholeCloud({ runs: [runRow(RUN, { pullRequestUrl: 'https://evil.example/phish' })] });
    const out = io();
    await runCloudRunsCli({ command: 'runs', limit: 5, json: false }, out.io, CONNECTION);
    expect(out.stdout.join('\n')).not.toContain('evil.example');
  });
});

describe('flows logs', () => {
  it('prints the runner log by default, and asks the route for no sandbox', async () => {
    const server = wholeCloud();
    const out = io();
    expect(await runCloudLogsCli(parseLogsArgs([RUN])!, out.io, CONNECTION)).toBe(0);
    expect(out.stdout[0]).toBe(`LOG ${RUN}  runner  ${RUNNER_LOG.length} bytes  complete`);
    expect(out.stdout[1]).toBe('[bootstrap] Starting workflow execution (per-step-sandbox)');
    expect(server.requests[0]!.query).toBe('');
  });

  it('prints every attempt of a retried step the runner log captured', async () => {
    // `flows logs <run-id>` has no journal to read: Cloud keeps the runner's
    // captured stderr and there is no journal-export endpoint. So every
    // attempt reaches a hosted reader only if the CLI printed every attempt in
    // the first place — which is why the log content here is built by the real
    // producer, `renderStepEvidence`, rather than written out by hand.
    const attempts = Array.from({ length: 7 }, (_unused, index) => ({
      attempt: index + 1, completionReason: 'verification_failed', exitCode: 1,
      stderrTail: `attempt ${index + 1} rejected by the pre-receive hook`,
    }));
    const diagnostic = renderStepEvidence({
      stepId: 'commit-and-push', stepType: 'deterministic', completionReason: 'retries_exhausted',
      attempt: 7, maxIterations: 7, exitCode: 1, attempts, attemptEvidence: 'differs',
    });
    const runner = `[bootstrap] Starting workflow execution (per-step-sandbox)\nFAILED [step_failed]${diagnostic}\n`;
    wholeCloud({ runner });
    const out = io();
    expect(await runCloudLogsCli(parseLogsArgs([RUN])!, out.io, CONNECTION)).toBe(0);
    const rendered = out.stdout.join('\n');
    // Not one attempt elided: the runner log is printed line for line, so the
    // first rejection is as readable here as the last.
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      expect(rendered).toContain(`attempt ${attempt} rejected by the pre-receive hook`);
    }
    expect(rendered).toContain('An earlier attempt may have had side effects.');
  });

  it('carries a first attempt whose only account is a gate verdict', async () => {
    // An attempt refused by a gate exits 0 with empty tails: the verdict is
    // the whole account of it. Read here with the production reader and
    // rendered with the production renderer, because a gate error dropped at
    // extraction is a gate error no hosted log can recover — Cloud keeps the
    // printed bytes and nothing else.
    const completion = (seq: number, attempt: number, payload: unknown) => ({
      seq, entry_type: 'step.completed', step_id: 'check', attempt, payload,
    });
    const entries = [
      completion(1, 1, {
        completionReason: 'verification_failed', disposition: 'retry',
        output: { exit_code: 0, stdout_tail: '', stderr_tail: '' },
        verification: {
          gate: 'output_contains', verdict: 'fail', detail: 'output did not contain "READY"',
        },
      }),
      completion(2, 2, {
        completionReason: 'retries_exhausted', disposition: 'step_done',
        output: { exit_code: 1, stdout_tail: '', stderr_tail: 'nothing staged in the declared scope' },
        verification: { gate: 'exit_code', verdict: 'fail', detail: 'exit code was 1' },
      }),
    ];
    const client = {
      runGet: async () => ({ steps: { check: { type: 'deterministic', state: 'done' } } }),
      journalRead: async (_run: string, from: number) => ({
        entries: entries.filter(entry => entry.seq >= from),
      }),
    } as unknown as JournalClient;
    const details = await stepFailureDetails(client, RUN);
    const runner = `FAILED [step_failed]${renderStepEvidence(details!)}\n`;
    wholeCloud({ runner });
    const out = io();
    expect(await runCloudLogsCli(parseLogsArgs([RUN])!, out.io, CONNECTION)).toBe(0);
    const rendered = out.stdout.join('\n');
    expect(rendered).toContain('output did not contain "READY"');
    expect(rendered).toContain('nothing staged in the declared scope');
  });

  it('renders an agent step’s transcript: session header, prose, one line per tool call, footer', async () => {
    const server = wholeCloud();
    const out = io();
    expect(await runCloudLogsCli(parseLogsArgs([RUN, '--step', 'agent-2'])!, out.io, CONNECTION)).toBe(0);
    expect(server.requests[0]!.query).toBe('?sandboxId=agent-2');
    const rendered = out.stdout.join('\n');
    expect(out.stdout[0]).toContain('step agent-2');
    expect(rendered).toContain('── attempt 1 · 5,873 bytes');
    expect(rendered).toContain('session  claude-opus-5 · v2.1.19 · bypassPermissions · 18 tools · 0 MCP servers');
    expect(rendered).toContain("  I'll read the file.");
    expect(rendered).toContain('  tool  Read  /project/notes.txt  → 25 chars');
    expect(rendered).toContain('  thinking  2 chars (not shown)');
    // A thinking block's text and cryptographic signature never reach the page.
    expect(rendered).not.toContain('CAIS');
    expect(rendered).toContain('── result success · 6.2s · 2 turns · $0.108098 · 4 in / 248 out · 25,402 cache read · 25,638 cache write');
    // The tool_result frame is folded into the call it answers, not printed twice.
    expect(rendered.match(/tool {2}Read/gu)).toHaveLength(1);
  });

  it('--raw prints the JSONL unrendered', async () => {
    wholeCloud();
    const out = io();
    expect(await runCloudLogsCli(parseLogsArgs([RUN, '--step', 'agent-2', '--raw'])!, out.io, CONNECTION)).toBe(0);
    expect(out.stdout.slice(1).join('\n').trimEnd()).toBe(TRANSCRIPT.trimEnd());
    expect(out.stdout.join('\n')).not.toContain('session  claude-opus-5');
  });

  it('marks a truncated attempt, an omitted attempt, an unrendered frame and an unparsed line', async () => {
    const truncated = [
      '{"type":"relayflow.attempt.omitted","attempt":1,"bytes":1048576}',
      '{"type":"relayflow.attempt","attempt":2,"bytes":900,"truncated":true}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_9","name":"Bash",'
        + '"input":{"command":"pytest -q"}}]}}',
      '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_9","type":"tool_result",'
        + '"content":"boom","is_error":true}]}}',
      '{"type":"stream_event","delta":"ignored"}',
      'this line is not JSON at all',
      '',
    ].join('\n');
    wholeCloud({ transcript: truncated });
    const out = io();
    expect(await runCloudLogsCli(parseLogsArgs([RUN, '--step', 'agent-2'])!, out.io, CONNECTION)).toBe(0);
    const rendered = out.stdout.join('\n');
    expect(rendered).toContain('── attempt 1 · 1,048,576 bytes · dropped whole to fit the log cap');
    expect(rendered).toContain('── attempt 2 · 900 bytes · head cut to fit the log cap');
    expect(rendered).toContain('  tool  Bash  pytest -q  → ERROR');
    expect(rendered).toContain('  frame  stream_event');
    expect(rendered).toContain('  unparsed  this line is not JSON at all');
  });

  it('prints a log that is not stream-json as written rather than claiming an empty transcript', async () => {
    wholeCloud({ transcript: 'plain terminal output from a v1 sandbox\n' });
    const out = io();
    expect(await runCloudLogsCli(parseLogsArgs([RUN, '--step', 'agent-2'])!, out.io, CONNECTION)).toBe(0);
    expect(out.stdout[1]).toBe('  not a stream-json transcript; printed as written');
    expect(out.stdout[2]).toBe('plain terminal output from a v1 sandbox');
  });

  it('redacts a credential the agent echoed, rendered and under --raw alike', async () => {
    const leaky = '{"type":"relayflow.attempt","attempt":1,"bytes":10,"truncated":false}\n'
      + '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text",'
      + '"text":"exported rk_live_NOTAREALSECRET1234"}]}}\n';
    wholeCloud({ transcript: leaky });
    for (const argv of [[RUN, '--step', 'agent-2'], [RUN, '--step', 'agent-2', '--raw']]) {
      const out = io();
      expect(await runCloudLogsCli(parseLogsArgs(argv)!, out.io, CONNECTION)).toBe(0);
      expect(out.stdout.join('\n')).not.toContain('rk_live_NOTAREALSECRET1234');
      expect(out.stdout.join('\n')).toContain('[redacted]');
    }
  });

  it('propagates a step-list failure instead of calling it a missing transcript', async () => {
    // The empty log body alone cannot tell an unknown step from a step that
    // has written nothing; the step list is the evidence for either. When that
    // read fails there is no finding, so the caller gets the real failure —
    // retryable or a scope to fix — not an invocation refusal.
    for (const [status, code] of [[403, 'cloud_forbidden'], [500, 'cloud_http_error']] as const) {
      let askedForLog = false;
      cloud((path, query) => {
        if (path.endsWith('/logs')) {
          askedForLog = query.get('sandboxId') === 'agent-2';
          return { body: { content: '', offset: 0, totalSize: 0, done: true } };
        }
        return { status, body: { error: 'nope' } };
      });
      const out = io();
      const exit = await runCloudLogsCli(parseLogsArgs([RUN, '--step', 'agent-2'])!, out.io, CONNECTION);
      expect(askedForLog).toBe(true);
      expect(exit).toBe(status === 403 ? 2 : 1);
      expect(out.stderr[0]).toContain(`REFUSED [${code}]`);
      expect(out.stderr[0]).not.toContain('cloud_step_no_transcript');
      if (status === 403) expect(out.stderr[0]).toContain(`the steps of run ${RUN}`);
    }
  });

  it('refuses a step that has no transcript, and names the ones that do', async () => {
    wholeCloud();
    const missing = io();
    expect(await runCloudLogsCli(parseLogsArgs([RUN, '--step', 'run-1'])!, missing.io, CONNECTION)).toBe(2);
    expect(missing.stdout).toEqual([]);
    expect(missing.stderr[0]).toBe(`REFUSED [cloud_step_no_transcript] Step "run-1" of run ${RUN} has no transcript.`
      + ' Only an agent step writes one; a deterministic step has none.');

    wholeCloud();
    const unknown = io();
    expect(await runCloudLogsCli(parseLogsArgs([RUN, '--step', 'nope'])!, unknown.io, CONNECTION)).toBe(2);
    expect(unknown.stderr[0]).toBe(`REFUSED [cloud_step_no_transcript] Run ${RUN} has no step "nope"`
      + ' — steps with a transcript: agent-2.');
  });
});

describe('flows status --cloud', () => {
  it('renders the run and its steps in the local status grammar', async () => {
    const server = wholeCloud();
    const out = io();
    const parsed = parseStatusArgs(['--cloud', RUN]);
    expect(parsed).toMatchObject({ command: 'status', cloud: true, runId: RUN });
    const code = await runCloudStatusCli(parsed!, out.io, { ...CONNECTION, now: () => Date.parse('2026-09-19T20:40:00Z') });
    expect(code).toBe(0);
    expect(out.stderr).toEqual([]);
    expect(out.stdout[0]).toBe(`RUN ${RUN}   insight-proof-2022   completed   started 5m01s ago`
      + '   finished success   spend 4 in / 248 out / $0.108098');
    expect(out.stdout[1]).toBe('steps 3: 3 completed');
    expect(out.stdout[2]).toBe('authority surface 2.0.22 · artifact 9c361a2cbb0a · commit b4dd665eb433');
    const rendered = out.stdout.join('\n');
    expect(rendered).toContain('✓ run-1       deterministic  completed    1 attempt  0.0s  success  gate: exit_code pass');
    expect(rendered).toContain('✓ agent-2     agent          completed    1 attempt  9.3s  success  gate: completion pass');
    expect(rendered).toContain('      transcript (attempt 1): claude-opus-5 · 2 turns · 1 tool call · $0.108098');
    expect(rendered).toContain('        7 of 7 frames, 5,873 bytes');
    expect(rendered).toContain('        4 in / 248 out · 25,402 cache read · 25,638 cache write');
    expect(rendered).toContain('        tools: Read ×1');
    expect(rendered).toContain('        artifacts: none');
    expect(rendered).toContain(`      logs: flows logs ${RUN} --step agent-2`);
    expect(server.requests.map((request) => request.path)).toEqual([
      `/api/v1/workflows/runs/${RUN}`, `/api/v1/workflows/runs/${RUN}/steps`,
    ]);
  });

  it('marks a failed gate and a step that finished for a reason other than success', async () => {
    cloud((path) => {
      if (path === `/api/v1/workflows/runs/${RUN}`) return { body: RUN_DETAIL };
      return {
        body: {
          steps: [{
            stepName: 'agent-2', stepType: 'agent', status: 'completed', completionReason: 'gate_failed',
            sandboxId: 'agent-2', cli: 'claude', durationMs: 120, retryCount: 1, tokensInput: 1, tokensOutput: 2,
            detail: {
              attempts: [{ attempt: 1 }, { attempt: 2 }], wallclockMs: 120,
              verification: { gate: 'completion', verdict: 'fail', detail: 'the body never reported done' },
            },
          }],
        },
      };
    });
    const out = io();
    await runCloudStatusCli({ runId: RUN, json: false }, out.io, { ...CONNECTION, now: () => Date.parse('2026-09-19T20:40:00Z') });
    const rendered = out.stdout.join('\n');
    expect(rendered).toContain('✗ agent-2');
    expect(rendered).toContain('2 attempts');
    expect(rendered).toContain('gate: completion fail');
    expect(rendered).toContain('gate: completion FAIL — "the body never reported done"');
  });

  it('emits one canonical JSON object under --json', async () => {
    wholeCloud();
    const out = io();
    await runCloudStatusCli({ runId: RUN, json: true }, out.io, { ...CONNECTION, now: () => 1 });
    expect(out.stdout).toHaveLength(1);
    const payload = JSON.parse(out.stdout[0]!) as { run: { run_id: string }; steps: Array<{ step_name: string }> };
    expect(payload.run.run_id).toBe(RUN);
    expect(payload.steps.map((step) => step.step_name)).toEqual(['run-1', 'agent-2', 'complete-3']);
  });

  it('refuses --cloud without a run id, and refuses the local-only flags with it', async () => {
    expect(parseStatusArgs(['--cloud'])).toBeUndefined();
    expect(parseStatusArgs(['--cloud', '--tail', '5', RUN])).toBeUndefined();
    expect(parseStatusArgs(['--cloud', '--data-dir', '/tmp/x', RUN])).toBeUndefined();
    const out = io();
    expect(await runCloudStatusCli({ json: false }, out.io, CONNECTION)).toBe(2);
    expect(out.stderr[0]).toContain('REFUSED [run_unknown]');
    expect(out.stderr[0]).toContain('`flows runs` lists them');
  });
});

describe('refusals', () => {
  it('names `agent-relay cloud login` when there is no credential at all', async () => {
    vi.stubEnv('FLOWS_CLOUD_TOKEN', undefined);
    vi.stubEnv('AGENT_RELAY_HOME', temporaryDirectory());
    const fetch = vi.spyOn(globalThis, 'fetch');
    const out = io();
    expect(await runCloudRunsCli({ command: 'runs', limit: 5, json: false }, out.io, { env: {} })).toBe(2);
    expect(out.stderr[0]).toBe('REFUSED [cloud_auth_missing] No Cloud credential. Sign in with '
      + '`agent-relay cloud login`, or set FLOWS_CLOUD_TOKEN to a Cloud API token with workflow:runs:read '
      + '(and workflow:logs:read for `flows logs`).');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('names the re-login remedy when the stored login has expired, before any request', async () => {
    const home = temporaryDirectory();
    writeFileSync(join(home, 'cloud-auth.json'), JSON.stringify({
      apiUrl: 'https://cloud-contract.example', accessToken: 'cld_at_expired',
      accessTokenExpiresAt: '2020-01-01T00:00:00.000Z',
    }));
    vi.stubEnv('FLOWS_CLOUD_TOKEN', undefined);
    vi.stubEnv('AGENT_RELAY_HOME', home);
    const fetch = vi.spyOn(globalThis, 'fetch');
    const out = io();
    expect(await runCloudLogsCli({ command: 'logs', runId: RUN, step: undefined, raw: false, json: false }, out.io, { env: {} })).toBe(2);
    expect(out.stderr[0]).toBe('REFUSED [cloud_auth_expired] The agent-relay cloud login has expired. '
      + 'Run `agent-relay cloud login` again, or set FLOWS_CLOUD_TOKEN.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('separates a run the credential cannot see (404) from one it may not read (403)', async () => {
    cloud(() => ({ status: 404, body: { error: 'Run not found' } }));
    const absent = io();
    expect(await runCloudStatusCli({ runId: RUN, json: false }, absent.io, CONNECTION)).toBe(2);
    expect(absent.stderr[0]).toContain('REFUSED [cloud_run_not_found]');
    expect(absent.stderr[0]).toContain('(HTTP 404)');
    expect(absent.stderr[0]).toContain('`flows runs` lists the ones this credential can read');

    cloud(() => ({ status: 403, body: { error: 'Forbidden' } }));
    const forbidden = io();
    expect(await runCloudLogsCli({ command: 'logs', runId: RUN, step: 'agent-2', raw: false, json: false }, forbidden.io, CONNECTION)).toBe(2);
    expect(forbidden.stderr[0]).toContain('REFUSED [cloud_forbidden]');
    expect(forbidden.stderr[0]).toContain(`step "agent-2" of run ${RUN}`);
    expect(forbidden.stderr[0]).toContain('workflow:logs:read');

    cloud(() => ({ status: 401, body: { error: 'Unauthorized' } }));
    const rejected = io();
    expect(await runCloudRunsCli({ command: 'runs', limit: 1, json: false }, rejected.io, CONNECTION)).toBe(2);
    expect(rejected.stderr[0]).toContain('REFUSED [cloud_auth_rejected]');
  });

  it('answers a refusal as JSON, not on stderr, under --json', async () => {
    cloud(() => ({ status: 404, body: { error: 'Run not found' } }));
    const out = io();
    expect(await runCloudStatusCli({ runId: RUN, json: true }, out.io, CONNECTION)).toBe(2);
    expect(out.stderr).toEqual([]);
    expect(JSON.parse(out.stdout[0]!)).toMatchObject({ v: 1, ok: false, code: 'cloud_run_not_found' });
  });

  it('never prints the credential, on any path', async () => {
    const secret = 'cld_at_supersecrettokenvalue';
    cloud(() => ({ status: 403, body: { error: 'Forbidden' } }));
    const out = io();
    await runCloudStatusCli({ runId: RUN, json: false }, out.io, { ...CONNECTION, token: secret });
    expect([...out.stdout, ...out.stderr].join('\n')).not.toContain(secret);
  });
});

describe('malformed and hostile responses', () => {
  it('refuses a run list whose `runs` is missing or not an array, rather than printing "runs 0"', async () => {
    for (const body of [{ nextCursor: null }, { runs: 'nope', nextCursor: null }]) {
      cloud(() => ({ body }));
      const out = io();
      expect(await runCloudRunsCli({ command: 'runs', limit: 5, json: false }, out.io, CONNECTION)).toBe(1);
      expect(out.stdout).toEqual([]);
      expect(out.stderr[0]).toContain('REFUSED [cloud_invalid_response]');
      expect(out.stderr[0]).toContain('no `runs` array');
    }
  });

  it('refuses a run-list row that is not an object, or has no runId', async () => {
    cloud(() => ({ body: { runs: [runRow(RUN), 'not-an-object'], nextCursor: null } }));
    const notObject = io();
    expect(await runCloudRunsCli({ command: 'runs', limit: 5, json: false }, notObject.io, CONNECTION)).toBe(1);
    expect(notObject.stderr[0]).toContain('a row that is not an object');

    cloud(() => ({ body: { runs: [{ status: 'completed' }], nextCursor: null } }));
    const nameless = io();
    expect(await runCloudRunsCli({ command: 'runs', limit: 5, json: false }, nameless.io, CONNECTION)).toBe(1);
    expect(nameless.stderr[0]).toContain('a row with no runId');
  });

  it('refuses a step list that is not an array, or a step row with no stepName', async () => {
    cloud((path) => path.endsWith('/steps')
      ? { body: { steps: { 'agent-2': {} } } }
      : { body: RUN_DETAIL });
    const notArray = io();
    expect(await runCloudStatusCli({ runId: RUN, json: false }, notArray.io, CONNECTION)).toBe(1);
    expect(notArray.stderr[0]).toContain('no `steps` array');

    cloud((path) => path.endsWith('/steps')
      ? { body: { steps: [{ status: 'completed' }] } }
      : { body: RUN_DETAIL });
    const nameless = io();
    expect(await runCloudStatusCli({ runId: RUN, json: false }, nameless.io, CONNECTION)).toBe(1);
    expect(nameless.stderr[0]).toContain('a row with no stepName');
  });

  it('refuses a run record for a different run, or one with no status', async () => {
    cloud((path) => path.endsWith('/steps')
      ? { body: STEPS }
      : { body: { ...RUN_DETAIL, runId: 'some-other-run' } });
    const mismatched = io();
    expect(await runCloudStatusCli({ runId: RUN, json: false }, mismatched.io, CONNECTION)).toBe(1);
    expect(mismatched.stderr[0]).toContain('a different run than the one requested');
    expect(mismatched.stdout).toEqual([]);

    cloud(() => ({ body: { runId: RUN } }));
    const statusless = io();
    expect(await runCloudStatusCli({ runId: RUN, json: false }, statusless.io, CONNECTION)).toBe(1);
    expect(statusless.stderr[0]).toContain('carried no status');
    // An unfamiliar status is Cloud's to add, not this client's to refuse.
    cloud((path) => path.endsWith('/steps') ? { body: { steps: [] } } : { body: { ...RUN_DETAIL, status: 'cancelling' } });
    const novel = io();
    expect(await runCloudStatusCli({ runId: RUN, json: false }, novel.io, { ...CONNECTION, now: () => 0 })).toBe(0);
    expect(novel.stdout[0]).toContain('cancelling');
  });

  it('stops a run listing whose cursor repeats, and one that never advances', async () => {
    const repeated = cloud(() => ({ body: { runs: [], nextCursor: 'same-cursor' } }));
    const looping = io();
    expect(await runCloudRunsCli({ command: 'runs', limit: 5, json: false }, looping.io, CONNECTION)).toBe(1);
    expect(looping.stderr[0]).toContain('repeated a run-list cursor');
    // Two requests: the first page, then the one that repeats its cursor.
    expect(repeated.requests).toHaveLength(2);

    let page = 0;
    const advancing = cloud(() => ({ body: { runs: [], nextCursor: `cursor-${page += 1}` } }));
    const endless = io();
    expect(await runCloudRunsCli({ command: 'runs', limit: 5, json: false }, endless.io, CONNECTION)).toBe(1);
    expect(endless.stderr[0]).toContain('without reaching the requested limit');
    expect(advancing.requests.length).toBeLessThanOrEqual(20);
  });

  it('treats a malformed run id as a bad invocation, and sends no request', async () => {
    for (const bad of ['../../etc/passwd', 'run id with spaces', '']) {
      const fetch = vi.spyOn(globalThis, 'fetch');
      const logs = io();
      expect(await runCloudLogsCli({ command: 'logs', runId: bad, step: undefined, raw: false, json: false },
        logs.io, CONNECTION)).toBe(2);
      expect(logs.stderr[0]).toContain('REFUSED [invalid_invocation]');
      expect(logs.stderr[0]).toContain('`flows runs` lists the ones this credential can read');
      expect(logs.stderr[0]).not.toContain('cloud_invalid_response');

      const status = io();
      expect(await runCloudStatusCli({ runId: bad || undefined, json: false }, status.io, CONNECTION)).toBe(2);
      expect(fetch).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });

  it('redacts the harness metadata a transcript frame carries, not just its prose', async () => {
    const leaky = [
      '{"type":"relayflow.attempt","attempt":1,"bytes":10,"truncated":false}',
      '{"type":"system","subtype":"init","model":"claude-opus-5","claude_code_version":"rk_live_VERSIONLEAK1",'
        + '"permissionMode":"rk_live_MODELEAK1","session_id":"rk_live_SESSIONLEAK1","tools_count":1}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1",'
        + '"name":"rk_live_TOOLNAMELEAK1","input":{"command":"echo rk_live_TARGETLEAK1"}}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"rk_live_BLOCKLEAK1","x":1}]}}',
      '{"type":"rk_live_FRAMELEAK1","x":1}',
      '{"type":"result","subtype":"rk_live_SUBTYPELEAK1","is_error":false,"num_turns":1}',
      '',
    ].join('\n');
    wholeCloud({ transcript: leaky });
    const rendered = io();
    expect(await runCloudLogsCli(parseLogsArgs([RUN, '--step', 'agent-2'])!, rendered.io, CONNECTION)).toBe(0);
    wholeCloud({ transcript: leaky });
    const json = io();
    expect(await runCloudLogsCli(parseLogsArgs([RUN, '--step', 'agent-2', '--json'])!, json.io, CONNECTION)).toBe(0);
    for (const out of [rendered, json]) {
      const text = out.stdout.join('\n');
      for (const leak of ['VERSIONLEAK1', 'MODELEAK1', 'SESSIONLEAK1', 'TOOLNAMELEAK1', 'TARGETLEAK1',
        'BLOCKLEAK1', 'FRAMELEAK1', 'SUBTYPELEAK1']) {
        expect(text, `${leak} reached the page`).not.toContain(leak);
      }
      expect(text).toContain('[redacted]');
    }
  });

  it('redacts a tool target longer than the display cap before truncating it', async () => {
    // `redact` matches an env value whole. Truncating first would leave the
    // first 160 characters of the secret on the page.
    const secret = `secret-${'x'.repeat(400)}-tail`;
    const leaky = '{"type":"relayflow.attempt","attempt":1,"bytes":10,"truncated":false}\n'
      + '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1",'
      + `"name":"Bash","input":{"command":"deploy --key ${secret}"}}]}}\n`;
    wholeCloud({ transcript: leaky });
    const out = io();
    const env = { DEPLOY_TOKEN: secret };
    expect(await runCloudLogsCli(parseLogsArgs([RUN, '--step', 'agent-2'])!, out.io, { ...CONNECTION, env })).toBe(0);
    const text = out.stdout.join('\n');
    expect(text).toContain('[redacted:DEPLOY_TOKEN]');
    expect(text).not.toContain(secret.slice(0, 160));
  });
});

describe('argv', () => {
  it('parses the three invocations and rejects the malformed ones', () => {
    expect(parseRunsArgs([])).toEqual({ command: 'runs', limit: 20, json: false });
    expect(parseRunsArgs(['--limit', '5', '--json'])).toEqual({ command: 'runs', limit: 5, json: true });
    expect(parseRunsArgs(['--limit', '0'])).toBeUndefined();
    expect(parseRunsArgs(['--limit'])).toBeUndefined();
    expect(parseRunsArgs(['extra'])).toBeUndefined();
    expect(parseLogsArgs([RUN])).toEqual({ command: 'logs', runId: RUN, step: undefined, raw: false, json: false });
    expect(parseLogsArgs([RUN, '--step', 'agent-2', '--raw', '--json']))
      .toEqual({ command: 'logs', runId: RUN, step: 'agent-2', raw: true, json: true });
    expect(parseLogsArgs([])).toBeUndefined();
    expect(parseLogsArgs([RUN, 'second'])).toBeUndefined();
    expect(parseLogsArgs([RUN, '--step'])).toBeUndefined();
    expect(parseLogsArgs([RUN, '--nope'])).toBeUndefined();
  });

  it('routes the verbs through runCli and lists them in --help', async () => {
    // Through `runCli` the credential comes from the environment, not an
    // options bag: this is the wiring test, so it exercises that path too.
    vi.stubEnv('FLOWS_CLOUD_URL', 'https://cloud-contract.example');
    vi.stubEnv('FLOWS_CLOUD_TOKEN', 'test-scoped-cloud-token');
    wholeCloud();
    const out = io();
    expect(await runCli(['runs', '--limit', '1', '--json'], out.io)).toBe(0);
    expect(JSON.parse(out.stdout[0]!)).toMatchObject({ ok: true });

    const help = io();
    expect(await runCli(['--help'], help.io)).toBe(0);
    expect(help.stdout[0]).toContain('flows runs [--limit <n>] [--json]');
    expect(help.stdout[0]).toContain('flows logs [--step <name>] [--raw] [--json] <run-id>');
    expect(help.stdout[0]).toContain('flows status --cloud [--json] <run-id>');
  });
});

describe('errorLines', () => {
  it('collapses the lease-renewal chatter that dominates a long run', () => {
    const text = [
      'Relayflow v2 CLI failed with exit code 1',
      ...Array.from({ length: 140 }, (_, i) =>
        `WAITING [worker_lease] Run "01M2Y03JWY9GE8K074KC2XMERR" step "agent-1" (agent) is running under a worker lease until ${1789860659414 + i}.`),
      'FAILED [step_failed] journal step "run-8" completed with retries_exhausted',
    ].join('\n');

    const lines = errorLines(text, '  ');

    expect(lines.length).toBeLessThan(10);
    expect(lines.every((line) => line.startsWith('  '))).toBe(true);
    expect(lines.some((line) => line.includes('(140 times, differing only in a number)'))).toBe(true);
    expect(lines.at(-1)).toContain('retries_exhausted');
  });

  it('keeps distinct lines that merely share a long prefix', () => {
    const prefix = 'WAITING [worker_lease] Run "01M2Y03JWY9GE8K074KC2XMERR" step ';
    const lines = errorLines([
      `${prefix}"agent-1" (agent) is running under a worker lease.`,
      `${prefix}"agent-2" (agent) is running under a worker lease.`,
      `${prefix}"agent-3" (agent) failed to acquire a worker lease.`,
    ].join('\n'), '');

    expect(lines).toHaveLength(3);
    expect(lines.some((line) => line.includes('times, differing only in a number'))).toBe(false);
    expect(lines.at(-1)).toContain('failed to acquire');
  });

  it('never collapses the final line into the repetition above it', () => {
    const lines = errorLines([
      'waiting for the lease until 10.',
      'waiting for the lease until 11.',
      'waiting for the lease until 12.',
    ].join('\n'), '');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('(2 times, differing only in a number)');
    expect(lines.at(-1)).toBe('waiting for the lease until 12.');
  });

  it('leaves lines that differ mid-message alone, even by only a number', () => {
    // Only a TRAILING counter collapses. `step 1 failed` and `step 2 failed`
    // are two distinct diagnostics, and a renderer that merged them would be
    // hiding exactly what the reader came for.
    const lines = errorLines(['step 1 failed', 'step 2 failed'].join('\n'), '');

    expect(lines).toEqual(['step 1 failed', 'step 2 failed']);
  });

  it('keeps a short error whole and strips control characters', () => {
    expect(errorLines('one\r\ntwothree', '')).toEqual(['one', 'two?three']);
  });

  it('elides the middle of a long run of distinct lines, keeping the tail', () => {
    const lines = errorLines(Array.from({ length: 60 }, (_, i) => `line ${'x'.repeat(50)} ${i} end`).join('\n'), '');

    expect(lines.some((line) => line.includes('more lines (full text: --json)'))).toBe(true);
    expect(lines.at(-1)).toContain('59');
    expect(lines).toHaveLength(15);
  });

  it('renders nothing for an error that is only whitespace', () => {
    expect(errorLines('\n\r\n  \n', '')).toEqual([]);
  });
});
