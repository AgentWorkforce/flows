import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkAuthoredFlow } from '../src/cli/check.js';
import type { FlowSpec } from '../src/spec.js';
// These tests isolate CLI authentication; environment refusal has its own suite.
vi.mock('../src/communication/preflight.js', () => ({ checkCommunicationEnvironment: vi.fn() }));
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(cli: string) {
  const root = mkdtempSync(join(tmpdir(), 'communication-preflight-')); roots.push(root);
  const executable = join(root, cli);
  writeFileSync(executable, '#!/bin/sh\nexit 0\n'); chmodSync(executable, 0o755);
  const config = { directory: root, models: [], executors: [] };
  const spec: FlowSpec = { version: '0.1.0', cli: executable, steps: [
    { id: 'a', type: 'agent', instruction: 'send' }, { id: 'b', type: 'agent', instruction: 'receive' },
  ], communication: { links: [{ from: 'a', to: 'b' }] } };
  return { spec, check: (flow = spec) => checkAuthoredFlow(flow, join(root, 'flow.yaml'), config) };
}
describe('managed CLI preflight', () => {
  it('probes known CLIs with the same filtered credentials as execution', () => {
    vi.stubEnv('GITHUB_TOKEN', 'unrelated'); vi.stubEnv('OPENAI_API_KEY', 'provider');
    const f = fixture('codex');
    writeFileSync(f.spec.cli!, '#!/bin/sh\n[ -z "$GITHUB_TOKEN" ] && [ "$OPENAI_API_KEY" = provider ]\n');
    expect(f.check().report.ok).toBe(true);
  });
  it.each(['gemini', 'opencode', 'cursor-agent', 'droid', 'aider', 'goose', 'grok', 'pi', 'deepagents', 'custom-interactive-agent'])('allows %s through Relay with an honest unverified-auth warning', cli => {
    const f = fixture(cli); const result = f.check();
    expect(result.report.ok).toBe(true);
    expect(result.report.diagnostics.filter(d => d.kind === 'managed_cli_unverified')).toHaveLength(2);
  });
  it('does not loosen ordinary wrapper preflight or cache a managed result for an ordinary step', () => {
    const f = fixture('gemini');
    const result = f.check({ ...f.spec, steps: [...f.spec.steps, { id: 'ordinary', type: 'agent', instruction: 'plain step' }] });
    expect(result.report.ok).toBe(false);
    expect(result.report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'cli_unsupported', stepId: 'ordinary' })]));
  });
  it('still refuses missing executables and failed known-CLI probes', () => {
    const f = fixture('codex');
    writeFileSync(f.spec.cli!, '#!/bin/sh\nexit 1\n');
    expect(f.check().report.ok).toBe(false);
    const missing = f.check({ ...f.spec, cli: join(f.spec.cli!, 'missing') });
    expect(missing.report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'cli_missing' })]));
  });
});
