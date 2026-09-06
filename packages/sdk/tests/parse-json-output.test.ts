import { describe, expect, it } from 'vitest';
import { parseJsonOutput } from '../src/worker.js';

// Unit tests for the CLI-output promotion helper AgentWorker uses to
// decide whether stdout becomes the step's `output` value or the
// CliResult wrapper is preserved. The live-kernel integration tests
// exercise the E2E promotion path; these tests pin the helper's
// boundary cases so a future edit is justified against explicit
// examples rather than inferred from a live test.

describe('parseJsonOutput', () => {
  it('returns null for empty stdout — nothing to promote', () => {
    expect(parseJsonOutput('')).toBeNull();
    expect(parseJsonOutput('   ')).toBeNull();
    expect(parseJsonOutput('\n\n')).toBeNull();
  });

  it('returns null for non-JSON stdout — text-emitting tool falls back to wrapper', () => {
    expect(parseJsonOutput('looked at the story, seemed fine')).toBeNull();
    expect(parseJsonOutput('progress: 50%\nprogress: 100%\ndone')).toBeNull();
    expect(parseJsonOutput('{"not-closed": ')).toBeNull();
  });

  it('promotes an object payload', () => {
    expect(parseJsonOutput('{"story_title":"x","relevance_score":5}')).toEqual({
      story_title: 'x',
      relevance_score: 5,
    });
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseJsonOutput('\n\n  {"ok": true}  \n')).toEqual({ ok: true });
  });

  it('rejects a bare scalar — schema authors expect field lookups', () => {
    expect(parseJsonOutput('42')).toBeNull();
    expect(parseJsonOutput('"hello"')).toBeNull();
    expect(parseJsonOutput('true')).toBeNull();
    expect(parseJsonOutput('null')).toBeNull();
  });

  it('rejects an array — schema authors expect an object shape', () => {
    expect(parseJsonOutput('[1,2,3]')).toBeNull();
    expect(parseJsonOutput('[{"a":1}]')).toBeNull();
  });

  it('does NOT try to extract JSON from mixed text+JSON output — chatty CLIs fall back to wrapper', () => {
    // Real LLM CLIs (claude -p, gemini) sometimes emit progress
    // text and end with a JSON blob. This helper deliberately does
    // NOT do "find the last JSON in the stream" — that heuristic
    // is a separate concern with different failure modes and would
    // silently promote whatever looked JSON-shaped. Instead, mixed
    // output stays as the CliResult wrapper; a schema author who
    // needs JSON should point at a wrapper CLI that emits only JSON.
    expect(parseJsonOutput('starting...\n{"result":42}')).toBeNull();
  });
});
