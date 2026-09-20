import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { checkFlow } from '../src/cli/check.js';
import { runFlow } from '../src/cli/run.js';

it('check and run refuse missing Relay prerequisites before creating a daemon or journal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'communication-refusal-'));
  vi.stubEnv('RELAY_API_KEY', undefined);
  try {
    const cli = join(root, 'gemini');
    writeFileSync(cli, '#!/bin/sh\nexit 0\n'); chmodSync(cli, 0o755);
    const path = join(root, 'flow.json');
    writeFileSync(path, JSON.stringify({ version: '0.1.0', cli,
      communication: { links: [{ from: 'a', to: 'b' }] },
      steps: [{ id: 'a', type: 'agent', instruction: 'send' }, { id: 'b', type: 'agent', instruction: 'receive' }],
    }));
    const checked = checkFlow(path);
    expect(checked.report.ok).toBe(false);
    expect(checked.flow).toBeUndefined();
    expect(checked.report.diagnostics).toContainEqual(expect.objectContaining({ severity: 'refusal', kind: 'probe_failed', message: expect.stringContaining('RELAY_API_KEY') }));
    const dataDir = join(root, 'data');
    const run = await runFlow(path, dataDir, { localAgent: true, daemon: { spawn: false } });
    expect(run.exitCode).toBe(2);
    expect(run.report.diagnostics).toContainEqual(expect.objectContaining({ kind: 'probe_failed', message: expect.stringContaining('RELAY_API_KEY') }));
    expect(run.report.diagnostics.some(d => d.kind === 'protocol_error' || d.kind === 'daemon_unreachable')).toBe(false);
    expect(existsSync(dataDir)).toBe(false);
  } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});
