// Rendering a Codex transcript in `flows logs <run> --step <agent-step>`.
//
// Provenance. Every frame shape asserted here was emitted by a real
// `codex exec --json` run of codex-cli 0.155.1 on 2026-09-21, captured on this
// machine. The two fixtures are those captures:
//
//   fixtures/codex-exec-json.jsonl          one run, verbatim except that the
//     `thread_id` and the `/tmp/...` working directory were replaced by stable
//     placeholders. A reviewer-shaped run: a shell command, an MCP tool call,
//     an `apply_patch`, and a multi-line verdict as its final message.
//   fixtures/codex-exec-json-failures.jsonl frames selected from four further
//     captured runs -- a `reasoning` item, a command that exited 1, an MCP
//     call the server refused, and a run against an unknown model, which is
//     what produced the `error` item, the top-level `error` frame and
//     `turn.failed`. Item ids were renumbered so the concatenation reads as
//     one thread; nothing else was edited.
//
// The JSONL built inline below is synthetic. It exercises lifecycle, bound,
// fallback and redaction branches that a captured run does not reach; the item
// and event names it uses are the ones the codex-cli binary's own enums carry.
// `item.updated` in particular is in that enum and was not observed in any
// capture, so its handling is pinned here and labelled for what it is.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAgentTranscript, renderAgentTranscript, type TranscriptEntry } from '../src/cloud-transcript.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

/** The env is always explicit, so no assertion depends on this machine. */
function parse(jsonl: string, env: NodeJS.ProcessEnv = {}): TranscriptEntry[] {
  return parseAgentTranscript(jsonl, env).entries;
}

function render(jsonl: string, env: NodeJS.ProcessEnv = {}): string {
  return renderAgentTranscript(parseAgentTranscript(jsonl, env)).join('\n');
}

function frames(...lines: object[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

function command(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'command_execution', command: 'pytest -q', ...overrides };
}

describe('the captured transcripts', () => {
  const REVIEW = fixture('codex-exec-json.jsonl');

  it('renders the reviewer run: thread, turn, numbered calls, file change, usage', () => {
    const rendered = render(REVIEW);
    expect(rendered).toContain('session  codex · thread 01a0c600-0000-7a10-a68c-000000000000');
    expect(rendered).toContain('── turn ─');
    expect(rendered).toContain("  tool 1  command_execution  /bin/bash -lc 'cat src/pricing.ts'"
      + '  → 110 chars · exit 0 · completed');
    expect(rendered).toContain('  tool 2  mcp_tool_call  demo/echo_shout {"text":"p2","options":{"mode":"loud"}}'
      + '  → 29 chars · completed');
    expect(rendered).toContain('  files  1 change · completed');
    expect(rendered).toContain('      add  /project/review.md');
    expect(rendered).toContain('── turn complete · 72,669 in / 244 out · 69,376 cache read'
      + ' · 0 cache write · 0 reasoning out');
  });

  it('prints the command output as a bounded excerpt, not only its size', () => {
    const rendered = render(REVIEW);
    expect(rendered).toContain('      export function total(cents: number, taxRate: number): number {');
    expect(rendered).toContain('        return Math.round(cents * (1 + taxRate));');
  });

  it('prints the final agent message in full — it is the step’s answer', () => {
    const rendered = render(REVIEW);
    expect(rendered).toContain([
      'assistant:',
      '  Verdict: changes_requested',
      '  ',
      '  The rounding in `total` truncates before the tax is applied, so a',
      '  0.5-cent remainder is lost on every line item.',
      '  ',
      '  One P2 remains and the gate artifact `review.clean` was not created.',
    ].join('\n'));
  });

  it('detects a Codex log with no relayflow.attempt wrapper as a transcript', () => {
    const parsed = parseAgentTranscript(REVIEW, {});
    expect(parsed.stream_json).toBe(true);
    expect(parsed.truncated_attempts).toBe(0);
    expect(parsed.omitted_attempts).toBe(0);
  });

  it('renders the failure run: reasoning as a count, failures keeping size and exit', () => {
    const rendered = render(fixture('codex-exec-json-failures.jsonl'));
    expect(rendered).toContain('  thinking  19 chars (not shown)');
    expect(rendered).not.toContain('Reviewing notes');
    expect(rendered).toContain("  tool 1  command_execution  /bin/bash -lc 'cat no-such-file.txt'"
      + '  → 49 chars · exit 1 · failed');
    expect(rendered).toContain('      cat: no-such-file.txt: No such file or directory');
    expect(rendered).toContain('  tool 2  mcp_tool_call  demo/echo_shout {"text":"boom"}  → no result · failed');
    expect(rendered).toContain('      error  tool call error: tool call failed for `demo/echo_shout`');
    expect(rendered).toContain('error (item):');
    expect(rendered).toContain('  Model metadata for `no-such-model-xyz` not found.');
    expect(rendered).toContain('── turn failed ─');
    expect(rendered).toContain('error (turn.failed):');
    expect(rendered).toContain("The 'no-such-model-xyz' model is not supported");
  });
});

describe('item lifecycles', () => {
  it('reports a started/completed pair once, at its completion', () => {
    const rendered = render(frames(
      { type: 'item.started', item: command('i1', { aggregated_output: '', exit_code: null, status: 'in_progress' }) },
      { type: 'item.completed', item: command('i1', { aggregated_output: 'ok\n', exit_code: 0, status: 'completed' }) },
      { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'done' } },
    ));
    expect(rendered.match(/tool 1 {2}command_execution/gu)).toHaveLength(1);
    expect(rendered).toBe([
      '  tool 1  command_execution  pytest -q  → 3 chars · exit 0 · completed',
      '      ok',
      'assistant:',
      '  done',
    ].join('\n'));
  });

  it('folds started/updated/completed into one call', () => {
    // `item.updated` is in codex-cli's event enum and was not observed in any
    // capture on this machine; this frame is synthetic.
    const rendered = render(frames(
      { type: 'item.started', item: command('i1', { aggregated_output: '', status: 'in_progress' }) },
      { type: 'item.updated', item: command('i1', { aggregated_output: 'partial', status: 'in_progress' }) },
      { type: 'item.completed', item: command('i1', { aggregated_output: 'whole', exit_code: 0, status: 'completed' }) },
    ));
    expect(rendered.match(/tool \d {2}command_execution/gu)).toHaveLength(1);
    expect(rendered).toContain('→ 5 chars · exit 0 · completed');
    expect(rendered).not.toContain('partial');
  });

  it('keeps an unfinished call, at its last snapshot, and says it never completed', () => {
    const rendered = render(frames(
      { type: 'item.started', item: command('i1', { aggregated_output: '', status: 'in_progress' }) },
      { type: 'item.updated', item: command('i1', { aggregated_output: 'half', status: 'in_progress' }) },
      { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'after' } },
    ));
    expect(rendered).toBe([
      '  tool 1  command_execution  pytest -q  → 4 chars · in_progress · no completion frame',
      '      half',
      'assistant:',
      '  after',
    ].join('\n'));
  });

  it('renders a completion with no start, which is what a head-cut log looks like', () => {
    const rendered = render(frames(
      { type: 'item.completed', item: command('i1', { aggregated_output: 'ok', exit_code: 0, status: 'completed' }) },
    ));
    expect(rendered).toBe('  tool 1  command_execution  pytest -q  → 2 chars · exit 0 · completed\n      ok');
  });

  it('never correlates items with no id', () => {
    const rendered = render(frames(
      { type: 'item.started', item: { type: 'command_execution', command: 'a', status: 'in_progress' } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'a', exit_code: 0, status: 'completed' } },
    ));
    expect(rendered.match(/command_execution/gu)).toHaveLength(2);
    expect(rendered).toContain('  tool 1  command_execution  a  → no result · in_progress · no completion frame');
    expect(rendered).toContain('  tool 2  command_execution  a  → no result · exit 0 · completed');
  });

  it('never correlates two item types that merely share an id', () => {
    const rendered = render(frames(
      { type: 'item.started', item: command('i1', { status: 'in_progress' }) },
      { type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 's', tool: 't', status: 'completed' } },
    ));
    expect(rendered).toContain('  tool 1  command_execution  pytest -q  → no result · in_progress · no completion frame');
    expect(rendered).toContain('  tool 2  mcp_tool_call  s/t  → no result · completed');
  });

  it('starts a new call when a start follows a completion of the same id', () => {
    const rendered = render(frames(
      { type: 'item.completed', item: command('i1', { aggregated_output: 'one', exit_code: 0, status: 'completed' }) },
      { type: 'item.started', item: command('i1', { aggregated_output: '', status: 'in_progress' }) },
    ));
    expect(rendered).toContain('  tool 1  command_execution  pytest -q  → 3 chars · exit 0 · completed');
    expect(rendered).toContain('  tool 2  command_execution  pytest -q  → 0 chars · in_progress · no completion frame');
  });

  it('keeps attempt 1’s unfinished call when attempt 2 completes the same id, and renumbers', () => {
    const rendered = render(frames(
      { type: 'relayflow.attempt', attempt: 1, bytes: 90, truncated: false },
      { type: 'item.started', item: command('i1', { aggregated_output: '', status: 'in_progress' }) },
      { type: 'relayflow.attempt', attempt: 2, bytes: 90, truncated: false },
      { type: 'item.completed', item: command('i1', { aggregated_output: 'ok', exit_code: 0, status: 'completed' }) },
    ));
    expect(rendered).toBe([
      '── attempt 1 · 90 bytes ────────────────────────────────────────────────',
      '  tool 1  command_execution  pytest -q  → 0 chars · in_progress · no completion frame',
      '── attempt 2 · 90 bytes ────────────────────────────────────────────────',
      '  tool 1  command_execution  pytest -q  → 2 chars · exit 0 · completed',
      '      ok',
    ].join('\n'));
  });

  it('does not correlate across a turn or a thread boundary', () => {
    const rendered = render(frames(
      { type: 'item.started', item: command('i1', { status: 'in_progress' }) },
      { type: 'turn.completed' },
      { type: 'item.completed', item: command('i1', { aggregated_output: 'ok', exit_code: 0, status: 'completed' }) },
      { type: 'thread.started', thread_id: 'th-2' },
      { type: 'item.completed', item: command('i1', { aggregated_output: 'ok', exit_code: 0, status: 'completed' }) },
    ));
    expect(rendered.match(/tool \d {2}command_execution/gu)).toHaveLength(3);
    // Numbering runs on across turns and threads; only an attempt resets it.
    expect(rendered).toContain('  tool 3  command_execution');
  });
});

describe('commands and MCP calls', () => {
  it('tells an empty output apart from a missing one', () => {
    const rendered = render(frames(
      { type: 'item.completed', item: command('i1', { aggregated_output: '', exit_code: 0, status: 'completed' }) },
      { type: 'item.completed', item: command('i2', { exit_code: 0, status: 'completed' }) },
    ));
    expect(rendered).toContain('  tool 1  command_execution  pytest -q  → 0 chars · exit 0 · completed');
    expect(rendered).toContain('  tool 2  command_execution  pytest -q  → no result · exit 0 · completed');
  });

  it('keeps exit 0 visible, and a failed status with no exit code', () => {
    const rendered = render(frames(
      { type: 'item.completed', item: command('i1', { aggregated_output: 'x', exit_code: 0, status: 'completed' }) },
      { type: 'item.completed', item: command('i2', { aggregated_output: 'x', exit_code: null, status: 'failed' }) },
    ));
    expect(rendered).toContain('→ 1 chars · exit 0 · completed');
    expect(rendered).toContain('  tool 2  command_execution  pytest -q  → 1 chars · failed');
  });

  it('bounds an oversized output to ten lines and keeps the full size on the line', () => {
    const output = `${Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n')}\n`;
    const rendered = render(frames(
      { type: 'item.completed', item: command('i1', { aggregated_output: output, exit_code: 0, status: 'completed' }) },
    ));
    expect(rendered).toContain(`→ ${output.length} chars · exit 0 · completed`);
    expect(rendered).toContain('      line 9');
    expect(rendered).not.toContain('      line 10');
    expect(rendered).toContain('      … excerpt cut at 10 lines / 1,000 chars — see --raw');
  });

  it('bounds an oversized single line of output by characters', () => {
    const output = 'z'.repeat(4000);
    const rendered = render(frames(
      { type: 'item.completed', item: command('i1', { aggregated_output: output, exit_code: 0, status: 'completed' }) },
    ));
    expect(rendered).toContain('→ 4,000 chars · exit 0 · completed');
    expect(rendered).toContain(`      ${'z'.repeat(1000)}`);
    expect(rendered).not.toContain('z'.repeat(1001));
    expect(rendered).toContain('… excerpt cut at 10 lines / 1,000 chars — see --raw');
  });

  it('serializes nested MCP arguments and shows a structured-only result', () => {
    const rendered = render(frames(
      { type: 'item.completed', item: {
        id: 'i1', type: 'mcp_tool_call', server: 'demo', tool: 'shout',
        arguments: { text: 'hi', options: { mode: 'loud', retries: 2 } },
        result: { structured_content: { shouted: 'HI' } }, error: null, status: 'completed',
      } },
    ));
    expect(rendered).toBe('  tool 1  mcp_tool_call  demo/shout'
      + ' {"text":"hi","options":{"mode":"loud","retries":2}}  → 16 chars · completed'
      + '\n      {"shouted":"HI"}');
  });

  it('shows an MCP result\u2019s text rather than only its size', () => {
    const rendered = render(frames(
      { type: 'item.completed', item: {
        id: 'i1', type: 'mcp_tool_call', server: 'demo', tool: 'shout', arguments: {},
        result: { content: [{ type: 'text', text: 'first block' }, { type: 'text', text: 'second block' }] },
        error: null, status: 'completed',
      } },
    ));
    expect(rendered).toContain('      first block');
    expect(rendered).toContain('      second block');
  });

  it('carries a string MCP result through, and skips a block with no text', () => {
    const rendered = render(frames(
      { type: 'item.completed', item: {
        id: 'i1', type: 'mcp_tool_call', server: 'demo', tool: 'a', arguments: {},
        result: { content: 'plain string result' }, error: null, status: 'completed',
      } },
      { type: 'item.completed', item: {
        id: 'i2', type: 'mcp_tool_call', server: 'demo', tool: 'b', arguments: {},
        result: { content: [{ type: 'image', data: 'AAAA' }, { type: 'text', text: 'only text' }] },
        error: null, status: 'completed',
      } },
    ));
    expect(rendered).toContain('      plain string result');
    expect(rendered).toContain('      only text');
    expect(rendered).not.toContain('AAAA');
  });

  it('bounds an oversized MCP result the same way command output is bounded', () => {
    const text = `${Array.from({ length: 40 }, (_, index) => `mcp ${index}`).join('\n')}`;
    const rendered = render(frames(
      { type: 'item.completed', item: {
        id: 'i1', type: 'mcp_tool_call', server: 'demo', tool: 'shout', arguments: {},
        result: { content: [{ type: 'text', text }] }, error: null, status: 'completed',
      } },
    ));
    expect(rendered).toContain('      mcp 9');
    expect(rendered).not.toContain('      mcp 10');
    expect(rendered).toContain('\u2026 excerpt cut at 10 lines / 1,000 chars \u2014 see --raw');
  });

  it('redacts an MCP result exactly as it redacts command output', () => {
    const rendered = render(frames(
      { type: 'item.completed', item: {
        id: 'i1', type: 'mcp_tool_call', server: 'demo', tool: 'shout', arguments: {},
        result: { content: [{ type: 'text', text: 'token sk-secret-value' }] },
        error: null, status: 'completed',
      } },
    ), { DEPLOY_TOKEN: 'sk-secret-value' });
    expect(rendered).not.toContain('sk-secret-value');
    expect(rendered).toContain('[redacted:DEPLOY_TOKEN]');
  });

  it('keeps a failed MCP call’s result size next to its error', () => {
    const rendered = render(frames(
      { type: 'item.completed', item: {
        id: 'i1', type: 'mcp_tool_call', server: 'demo', tool: 'shout', arguments: {},
        result: { content: [{ type: 'text', text: 'partial output' }] },
        error: { message: 'server refused' }, status: 'failed',
      } },
    ));
    expect(rendered).toContain('  tool 1  mcp_tool_call  demo/shout {}  → 14 chars · failed');
    expect(rendered).toContain('      partial output');
    expect(rendered).toContain('      error  server refused');
  });
});

describe('fallbacks', () => {
  /**
   * This case used `todo_list` and `web_search` as its stand-ins for an
   * unsupported item type. Both are parsed since 2.0.33, so it now uses a type
   * Codex does not define — which is what the fallback is actually for: an item
   * a future codex-cli adds and this module has never seen. The payload must
   * still not reach the page, because nothing here knows which of its fields
   * are safe to print.
   */
  it('names the item type in the placeholder, on every lifecycle event', () => {
    const rendered = render(frames(
      { type: 'item.started', item: { id: 'i1', type: 'some_future_item', secret: 'relayflow' } },
      { type: 'item.updated', item: { id: 'i1', type: 'some_future_item', secret: 'relayflow' } },
      { type: 'item.completed', item: { id: 'i2', type: 'another_future_item', secret: 'relayflow' } },
    ));
    expect(rendered).toContain('  frame  item.started/some_future_item (');
    expect(rendered).toContain('  frame  item.updated/some_future_item (');
    expect(rendered).toContain('  frame  item.completed/another_future_item (');
    expect(rendered).not.toContain('relayflow');
  });

  it('falls back rather than inventing success for a malformed known item', () => {
    const rendered = render(frames(
      { type: 'item.completed', item: { id: 'i1', type: 'command_execution', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'i2', type: 'agent_message' } },
      { type: 'item.completed', item: { id: 'i3', type: 'reasoning', text: 42 } },
      { type: 'item.completed', item: { id: 'i4', type: 'file_change', changes: 'nope' } },
      { type: 'item.completed', item: { id: 'i5', type: 'mcp_tool_call', status: 'completed' } },
      { type: 'item.completed', item: 'not an object' },
    ));
    for (const label of ['item.completed/command_execution', 'item.completed/agent_message',
      'item.completed/reasoning', 'item.completed/file_change', 'item.completed/mcp_tool_call']) {
      expect(rendered, label).toContain(`  frame  ${label} (`);
    }
    expect(rendered).toContain('  frame  item.completed (');
    expect(rendered).not.toContain('→ ');
    // A malformed item must never spend a call number.
    expect(rendered).not.toContain('tool 1');
  });

  it('counts malformed file changes instead of dropping them', () => {
    const rendered = render(frames(
      { type: 'item.completed', item: { id: 'i1', type: 'file_change', status: 'completed', changes: [
        { path: '/project/a.ts', kind: 'update' }, 'nope', { kind: 'delete' }, {},
      ] } },
    ));
    expect(rendered).toBe([
      '  files  4 changes · completed',
      '      update  /project/a.ts',
      '      delete  (no path)',
      '      2 changes not rendered here — see --raw',
    ].join('\n'));
  });

  it('says an unfinished file change never completed', () => {
    const rendered = render(frames(
      { type: 'item.started', item: { id: 'i1', type: 'file_change', status: 'in_progress', changes: [
        { path: '/project/a.ts', kind: 'add' },
      ] } },
    ));
    expect(rendered).toContain('  files  1 change · in_progress · no completion frame');
  });

  it('keeps non-JSON, non-object and cut lines visible', () => {
    const jsonl = `${frames({ type: 'turn.started' }).trimEnd()}\n`
      + '"just a string"\n[1,2,3]\nnot json at all\n{"type":"item.completed","item":{"id":"i1"\n';
    const rendered = render(jsonl);
    expect(rendered).toContain('  unparsed  not json at all');
    expect(rendered).toContain('  unparsed  "just a string"');
    expect(rendered).toContain('  unparsed  [1,2,3]');
    expect(rendered).toContain('  unparsed  {"type":"item.completed","item":{"id":"i1"');
  });

  it('marks a turn.failed with no readable message as a failure anyway', () => {
    const rendered = render(frames({ type: 'turn.failed' }));
    expect(rendered).toBe('── turn failed ─────────────────────────────────────────────────────────\n'
      + 'error (turn.failed):\n  (no message)');
  });
});

describe('redaction', () => {
  it('scrubs a token shape out of every string it renders', () => {
    const jsonl = frames(
      { type: 'thread.started', thread_id: 'rk_live_THREADLEAK1' },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'exported rk_live_MESSAGELEAK1' } },
      { type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: 'echo rk_live_COMMANDLEAK1',
        aggregated_output: 'printed rk_live_OUTPUTLEAK1', exit_code: 1, status: 'rk_live_STATUSLEAK1' } },
      { type: 'item.completed', item: { id: 'i3', type: 'mcp_tool_call', server: 'rk_live_SERVERLEAK1',
        tool: 'rk_live_TOOLLEAK1', arguments: { note: 'rk_live_ARGLEAK1' }, result: null,
        error: { message: 'rk_live_ERRORLEAK1' }, status: 'failed' } },
      { type: 'item.completed', item: { id: 'i4', type: 'file_change', status: 'completed',
        changes: [{ path: '/project/rk_live_PATHLEAK1.ts', kind: 'rk_live_KINDLEAK1' }] } },
      { type: 'item.completed', item: { id: 'i5', type: 'rk_live_ITEMTYPELEAK1' } },
      { type: 'item.completed', item: { id: 'i6', type: 'error', message: 'rk_live_ITEMERRORLEAK1' } },
      { type: 'error', message: 'rk_live_FRAMEERRORLEAK1' },
      { type: 'turn.failed', error: { message: 'rk_live_TURNERRORLEAK1' } },
    );
    const leaks = ['THREADLEAK1', 'MESSAGELEAK1', 'COMMANDLEAK1', 'OUTPUTLEAK1', 'STATUSLEAK1', 'SERVERLEAK1',
      'TOOLLEAK1', 'ARGLEAK1', 'ERRORLEAK1', 'PATHLEAK1', 'KINDLEAK1', 'ITEMTYPELEAK1', 'ITEMERRORLEAK1',
      'FRAMEERRORLEAK1', 'TURNERRORLEAK1'];
    // Both the rendered page and the `--json` entries, which bypass the renderer.
    for (const text of [render(jsonl), JSON.stringify(parse(jsonl))]) {
      for (const leak of leaks) expect(text, `${leak} reached the page`).not.toContain(leak);
      expect(text).toContain('[redacted]');
    }
  });

  it('redacts a credential field nested in MCP arguments', () => {
    const jsonl = frames({ type: 'item.completed', item: {
      id: 'i1', type: 'mcp_tool_call', server: 'demo', tool: 'deploy',
      arguments: { config: { apiKey: 'opaque-value-nobody-exported' } }, result: null, error: null,
      status: 'completed',
    } });
    const rendered = render(jsonl);
    expect(rendered).not.toContain('opaque-value-nobody-exported');
    expect(rendered).toContain('"apiKey":"[redacted]"');
  });

  it('redacts an MCP argument secret that JSON escaping would hide, at every depth', () => {
    // `redact` matches an env value literally, and `JSON.stringify` escapes a
    // quote, backslash, newline or tab inside it. Serializing before redacting
    // left the whole credential on the line -- escaped, and recoverable by
    // anyone who can call `JSON.parse`. The field names here are ordinary
    // (`text`, `note`, `items`), so the credential-field rule cannot help.
    const secret = 'opaque"review\\secret\nvalue\ttail';
    const env = { DEPLOY_TOKEN: secret };
    const escaped = JSON.stringify(secret).slice(1, -1);
    const call = (id: string, args: unknown): Record<string, unknown> => ({
      type: 'item.completed',
      item: { id, type: 'mcp_tool_call', server: 'demo', tool: 'echo', arguments: args,
        result: null, error: null, status: 'completed' },
    });
    const jsonl = frames(
      call('i1', { text: secret, nested: { note: { deep: secret } } }),
      call('i2', [secret, { items: [secret] }]),
      call('i3', secret),
      call('i4', { [secret]: 'in the name, not the value' }),
    );
    // The rendered page and the `--json` entries, which bypass the renderer.
    for (const text of [render(jsonl, env), JSON.stringify(parse(jsonl, env))]) {
      expect(text, 'the secret reached the page').not.toContain(secret);
      expect(text, 'the escaped secret reached the page').not.toContain(escaped);
      expect(text).toContain('[redacted:DEPLOY_TOKEN]');
    }
    expect(render(jsonl, env)).toContain('  tool 1  mcp_tool_call  demo/echo'
      + ' {"text":"[redacted:DEPLOY_TOKEN]","nested":{"note":{"deep":"[redacted:DEPLOY_TOKEN]"}}}'
      + '  → no result · completed');
  });

  it('redacts a secret longer than each display cap before bounding it', () => {
    // `redact` matches an env value whole. Bounding first would leave the
    // first 160 (or 200, or 1,000) characters of the secret on the page.
    const secret = `secret-${'x'.repeat(1200)}-tail`;
    const env = { DEPLOY_TOKEN: secret };
    const jsonl = frames(
      { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: `deploy --key ${secret}`,
        aggregated_output: `sent ${secret}`, exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'i2', type: 'file_change', status: 'completed',
        changes: [{ path: `/project/${secret}.ts`, kind: 'add' }] } },
      { type: 'turn.failed', error: { message: `failed with ${secret}` } },
    );
    for (const text of [render(jsonl, env), JSON.stringify(parse(jsonl, env))]) {
      expect(text).toContain('[redacted:DEPLOY_TOKEN]');
      expect(text).not.toContain(secret.slice(0, 160));
    }
  });

  it('replaces terminal control characters in every new rendering branch', () => {
    const bell = '\u0007';
    const rendered = render(frames(
      { type: 'thread.started', thread_id: `th${bell}1` },
      { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: `echo${bell}`,
        aggregated_output: `out${bell}`, exit_code: 0, status: `done${bell}` } },
      { type: 'item.completed', item: { id: 'i2', type: 'file_change', status: 'completed',
        changes: [{ path: `/p${bell}.ts`, kind: `add${bell}` }] } },
      { type: 'item.completed', item: { id: 'i3', type: `weird${bell}` } },
      { type: 'error', message: `boom${bell}` },
    ));
    expect(rendered).not.toContain(bell);
    expect(rendered).toContain('session  codex · thread th?1');
    expect(rendered).toContain('echo?');
    expect(rendered).toContain('      out?');
    expect(rendered).toContain('      add?  /p?.ts');
    expect(rendered).toContain('weird?');
    expect(rendered).toContain('  boom?');
  });
});

describe('the Claude vocabulary is untouched', () => {
  const CLAUDE = frames(
    { type: 'relayflow.attempt', attempt: 1, bytes: 400, truncated: false },
    { type: 'system', subtype: 'init', model: 'claude-opus-5', claude_code_version: '2.1.19',
      permissionMode: 'bypassPermissions', session_id: '4076fae9', tools_count: 18, mcp_servers_count: 0 },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/project/notes.txt' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [
      { tool_use_id: 'toolu_1', type: 'tool_result', content: 'alpha', is_error: true },
    ] } },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 2 },
  );

  it('renders unnumbered Claude tool lines and carries no Codex fields', () => {
    expect(render(CLAUDE)).toContain('  tool  Read  /project/notes.txt  → ERROR');
    expect(JSON.stringify(parse(CLAUDE))).not.toContain('codex');
    expect(parse(CLAUDE).filter((entry) => entry.kind === 'tool')).toEqual([
      { kind: 'tool', name: 'Read', target: '/project/notes.txt', result_chars: 5, is_error: true, nested: false },
    ]);
  });

  it('renders a log that mixes both vocabularies, each in its own shape', () => {
    const rendered = render(CLAUDE + frames(
      { type: 'item.completed', item: command('i1', { aggregated_output: 'ok', exit_code: 0, status: 'completed' }) },
    ));
    expect(rendered).toContain('  tool  Read  /project/notes.txt  → ERROR');
    expect(rendered).toContain('  tool 1  command_execution  pytest -q  → 2 chars · exit 0 · completed');
  });

  it('still counts truncated and omitted attempts around Codex frames', () => {
    const parsed = parseAgentTranscript(frames(
      { type: 'relayflow.attempt.omitted', attempt: 1, bytes: 1048576 },
      { type: 'relayflow.attempt', attempt: 2, bytes: 900, truncated: true },
      { type: 'item.completed', item: command('i1', { aggregated_output: 'ok', exit_code: 0, status: 'completed' }) },
    ), {});
    expect(parsed.truncated_attempts).toBe(1);
    expect(parsed.omitted_attempts).toBe(1);
  });

  it('reports a log in neither vocabulary as not a transcript', () => {
    expect(parseAgentTranscript('plain terminal output\n', {}).stream_json).toBe(false);
  });
});

/**
 * The rest of Codex's `ThreadItemDetails` union
 * (codex-rs/exec/src/exec_events.rs). These three were reported as bare
 * `unknown` placeholders until 2.0.33 — honest but unreadable, and
 * `todo_list` is the one that updates continuously through a real turn.
 */
describe('the remaining Codex item types', () => {
  it('renders a running to-do list as a plan, not a call', () => {
    const parsed = parseAgentTranscript([
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'todo_list', items: [
        { text: 'read the failing test', completed: true },
        { text: 'fix the parser', completed: false },
      ] } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n'), {});

    const todo = parsed.entries.find(entry => entry.kind === 'todo');
    expect(todo).toMatchObject({ kind: 'todo', total: 2, done: 1 });
    // A plan takes no sequence number: it is not a call.
    expect(parsed.entries.filter(entry => entry.kind === 'tool')).toHaveLength(0);
  });

  it('renders a web search as a numbered call with its result count', () => {
    const parsed = parseAgentTranscript(JSON.stringify({
      type: 'item.completed',
      item: { id: 'i0', type: 'web_search', query: 'codex exec json events', action: { type: 'search' },
        results: [{ url: 'a' }, { url: 'b' }] },
    }), {});

    expect(parsed.entries.find(entry => entry.kind === 'tool')).toMatchObject({
      kind: 'tool', name: 'web_search', target: 'codex exec json events',
      codex: { seq: 1, status: 'search', output_excerpt: '2 results' },
    });
  });

  /**
   * A status is provider text, not a closed vocabulary this module controls, and
   * this layer IS the redactor — every neighbouring field goes through
   * `context.clean`. The summary was the one string that did not.
   */
  it('redacts a collab agent status like every neighbouring field', () => {
    const parsed = parseAgentTranscript(JSON.stringify({
      type: 'item.completed',
      item: { id: 'i0', type: 'collab_tool_call', tool: 'spawn_agent',
        sender_thread_id: 's', receiver_thread_ids: ['r1'],
        agents_states: { a: { status: 'failed: token sk-ant-0123456789abcdefghij' } },
        status: 'failed' },
    }), {});

    const rendered = JSON.stringify(parsed.entries);
    expect(rendered).not.toContain('sk-ant-0123456789abcdefghij');
    expect(rendered).toContain('[redacted]');
  });

  it('counts completed todos across the whole plan, not the displayed prefix', () => {
    // 13 items, only the last one done: the display caps at 12, the count must not.
    const items = Array.from({ length: 13 }, (_unused, index) => ({
      text: `task ${index}`, completed: index === 12,
    }));
    const parsed = parseAgentTranscript(JSON.stringify({
      type: 'item.completed', item: { id: 'i0', type: 'todo_list', items },
    }), {});

    // Used to render 0/13, which is backwards from "counted, not printed".
    expect(parsed.entries.find(entry => entry.kind === 'todo'))
      .toMatchObject({ total: 13, done: 1, omitted: 1 });
  });

  it('summarises collab agents by status, never by agent id', () => {
    const parsed = parseAgentTranscript(JSON.stringify({
      type: 'item.completed',
      item: { id: 'i0', type: 'collab_tool_call', tool: 'spawn_agent',
        sender_thread_id: 'sender-thread-id', receiver_thread_ids: ['r1', 'r2'],
        agents_states: {
          'agent-id-nobody-can-act-on': { status: 'running', message: null },
          'another-agent-id': { status: 'completed', message: null },
        },
        status: 'completed' },
    }), {});

    const entry = parsed.entries.find(item => item.kind === 'tool');
    expect(entry).toMatchObject({ kind: 'tool', name: 'collab_tool_call', target: 'spawn_agent → 2 threads' });
    expect(entry).toHaveProperty('codex.output_excerpt', '1 completed, 1 running');
    // Agent ids are not something a transcript reader can act on.
    expect(JSON.stringify(parsed.entries)).not.toContain('agent-id-nobody-can-act-on');
  });
});
