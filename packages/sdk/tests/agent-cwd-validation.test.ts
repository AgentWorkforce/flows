import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { validateSpec } from '../src/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const agent = (cwd: unknown) => ({ version: '0.1.0', steps: [{ id: 'a', type: 'agent', instruction: 'x', cwd }] });

// The kernel refuses a relative agent cwd at run.start (spec.rs RelativeStepCwd).
// A declarative flow must be refused by `flows check` the same way, not accepted
// and then refused minutes later.
describe('declarative agent cwd', () => {
  it('accepts an absolute cwd and refuses a relative or empty one', () => {
    expect(validateSpec(agent('/repo/.wt/api')).ok).toBe(true);
    for (const cwd of ['worktrees/api', './api', '']) {
      const result = validateSpec(agent(cwd));
      expect(result.ok).toBe(false);
      expect(result.errors.join(' ')).toContain('steps[0].cwd: expected an absolute path');
    }
  });

  it('is refused by `flows check` on a YAML flow before anything runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-cwd-')); roots.push(root);
    const flow = join(root, 'flow.yaml');
    writeFileSync(flow, 'version: 0.1.0\nsteps:\n  - id: a\n    type: agent\n    instruction: x\n    cwd: worktrees/api\n');
    const checked = spawnSync(process.execPath, [resolve('dist/cli.js'), 'check', flow], { cwd: root, encoding: 'utf8' });
    expect(checked.status).toBe(2);
    expect(checked.stdout + checked.stderr).toContain('cwd: expected an absolute path');
  });
});
