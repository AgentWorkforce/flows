import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkFlow } from '../src/cli/check.js';

const RUN_REAL = process.env['RELAYFLOWS_REAL_CLI_ADAPTERS'] === '1';
const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function realFlow(cli: 'claude' | 'codex', model: string): string {
  const directory = mkdtempSync(join(tmpdir(), `flows-real-${cli}-`));
  directories.push(directory);
  writeFileSync(join(directory, 'flows.json'), JSON.stringify({ models: [model] }));
  const path = join(directory, `${cli}.flow.yaml`);
  writeFileSync(path, `version: '0.1.0'
agents:
  reviewer: { cli: ${cli}, model: ${model} }
steps:
  - id: review
    type: agent
    agent: reviewer
    instruction: Review.
`);
  return path;
}

describe.runIf(RUN_REAL)('installed raw CLI adapters', () => {
  it('round-trips the exact declared Claude model and refuses an impossible one', () => {
    const available = process.env['RELAYFLOWS_REAL_CLAUDE_MODEL'] ?? 'claude-haiku-4-5-20251001';
    expect(checkFlow(realFlow('claude', available)).report.ok).toBe(true);

    const impossible = 'relayflows-definitely-not-a-real-claude-model';
    const refused = checkFlow(realFlow('claude', impossible)).report;
    expect(refused.ok).toBe(false);
    expect(refused.diagnostics).toContainEqual(expect.objectContaining({ kind: 'model_unavailable' }));
  }, 130_000);

  it('uses Codex login status and classifies an impossible model as unavailable', () => {
    const impossible = 'relayflows-definitely-not-a-real-codex-model';
    const refused = checkFlow(realFlow('codex', impossible)).report;
    expect(refused.ok).toBe(false);
    expect(refused.diagnostics).toContainEqual(expect.objectContaining({ kind: 'model_unavailable' }));
    expect(refused.diagnostics).not.toContainEqual(expect.objectContaining({ kind: 'cli_unauthenticated' }));
  }, 70_000);
});
