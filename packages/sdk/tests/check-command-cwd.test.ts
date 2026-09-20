import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkFlow } from '../src/cli/check.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('path-like deterministic commands are probed where the step will run', () => {
  it('resolves ./script against the invoking cwd, not the flow file directory', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'check-cwd-source-'));
    const runDir = await mkdtemp(join(tmpdir(), 'check-cwd-run-'));
    dirs.push(sourceDir, runDir);
    const flow = join(sourceDir, 'flow.yaml');
    await writeFile(flow, JSON.stringify({
      version: '0.1.0', name: 'cwd-proof',
      steps: [{ id: 'exec', type: 'deterministic', command: './run.sh' }],
    }));
    await writeFile(join(runDir, 'run.sh'), '#!/bin/sh\necho ok\n');
    await chmod(join(runDir, 'run.sh'), 0o755);

    vi.spyOn(process, 'cwd').mockReturnValue(runDir);
    expect(checkFlow(flow).report.ok).toBe(true);

    vi.spyOn(process, 'cwd').mockReturnValue(sourceDir);
    const refused = checkFlow(flow).report;
    expect(refused.ok).toBe(false);
    expect(refused.diagnostics).toContainEqual(expect.objectContaining({ kind: 'command_missing', stepId: 'exec' }));
  });
});
