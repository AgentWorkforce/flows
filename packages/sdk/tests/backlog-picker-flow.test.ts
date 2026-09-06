import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * The backlog-picker flow's steps must agree with each other.
 *
 * Originally every step re-read ops/BACKLOG.md, so if the file changed between
 * `select-entry` and `emit-package` the emitted package would describe an entry
 * that was never selected — a Garden reporting work it did not choose. Review
 * flagged it (PR #20, P2) and the fix snapshots the backlog once in
 * `read-backlog`; this test is the proof that was asked for and not delivered.
 *
 * It runs the flow's ACTUAL shell commands rather than a reimplementation. A
 * test of a paraphrase would pass while the flow stayed broken.
 */
function stepCommands(): Record<string, string> {
  const flowPath = join(__dirname, '..', '..', '..', 'testdata', 'backlog-picker.flow.yaml');
  const flow = load(readFileSync(flowPath, 'utf8')) as { steps: Array<{ id: string; command: string }> };
  return Object.fromEntries(flow.steps.map((s) => [s.id, s.command]));
}

function run(command: string, cwd: string): string {
  // The steps run in a throwaway cwd, so point them at the real built SDK
  // rather than making them hunt for one that is not there.
  return execFileSync('sh', ['-c', command], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // Capture stderr instead of letting it through to ours. Several tests here
    // assert that a step FAILS, and `execFileSync` otherwise echoes the child's
    // stack trace into the suite's output -- so a passing run prints
    // `ENOENT ... .relayflow/backlog-picker-entry.json` and looks broken.
    // #156 was filed on exactly that appearance. The text is still available on
    // the thrown error for a test that wants to assert on it.
    env: { ...process.env, RELAYFLOWS_SDK_DIST: join(__dirname, '..', 'dist') },
  });
}

describe('backlog-picker flow', () => {
  it('emit-package describes the entry select-entry chose, even if the backlog changes between them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backlog-picker-'));
    try {
      mkdirSync(join(dir, 'ops'), { recursive: true });
      writeFileSync(
        join(dir, 'ops', 'BACKLOG.md'),
        '# Backlog\n\n- **Original entry** the one that must win, touching `sdk/src/a.ts` with `the picker still selects it`\n',
      );

      const steps = stepCommands();
      run(steps['read-backlog'], dir);

      const selected = run(steps['select-entry'], dir).trim();
      expect(selected).toContain('Original entry');

      // The backlog changes underneath the flow, mid-run.
      writeFileSync(
        join(dir, 'ops', 'BACKLOG.md'),
        '# Backlog\n\n- **Swapped entry** must NOT appear in the package\n',
      );

      const emitted = run(steps['emit-package'], dir);
      expect(emitted).toContain('Original entry');
      expect(emitted).not.toContain('Swapped entry');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not emit a stale entry left by a previous run', () => {
    // The snapshot fix introduced shared persistent state, and shared state
    // leaks across runs: if select-entry finds nothing actionable it exits
    // before writing, so emit-package would happily read the PREVIOUS run's
    // entry and present it as this run's choice. Review caught it (PR #21, P1)
    // — a fix for cross-step disagreement that created cross-run staleness.
    const dir = mkdtempSync(join(tmpdir(), 'backlog-picker-stale-'));
    try {
      mkdirSync(join(dir, 'ops'), { recursive: true });
      const steps = stepCommands();

      // Run one: a real entry, which populates the shared state.
      writeFileSync(join(dir, 'ops', 'BACKLOG.md'), '# Backlog\n\n- **Yesterday entry** old, touching `sdk/src/a.ts` with `it must not be reused`\n');
      run(steps['read-backlog'], dir);
      run(steps['select-entry'], dir);
      expect(run(steps['emit-package'], dir)).toContain('Yesterday entry');

      // Run two: nothing actionable. select-entry must fail AND must not leave
      // the previous choice behind for emit-package to pick up.
      writeFileSync(join(dir, 'ops', 'BACKLOG.md'), '# Backlog\n\nnothing actionable today\n');
      run(steps['read-backlog'], dir);
      expect(() => run(steps['select-entry'], dir)).toThrow();

      let emitted = '';
      try {
        emitted = run(steps['emit-package'], dir);
      } catch {
        return; // Failing outright is the correct outcome.
      }
      expect(emitted).not.toContain('Yesterday entry');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('backlog-picker canonical spec', () => {
  it('stays in sync with the flow yaml', () => {
    // The canonical spec is what the kernel consumes. PR #22 fixed the path
    // matcher in the yaml and left the canonical spec carrying the old
    // permissive one, so the fix did not reach the thing that runs — review
    // caught it. A divergence between the two is silent by nature: both files
    // are valid, the tests over the yaml pass, and the kernel keeps executing
    // the stale command.
    const root = join(__dirname, '..', '..', '..');
    const flow = load(readFileSync(join(root, 'testdata', 'backlog-picker.flow.yaml'), 'utf8')) as {
      steps: Array<{ id: string; command?: string }>;
    };
    const canonical = JSON.parse(
      readFileSync(join(root, 'testdata', 'backlog-picker.spec.canonical.json'), 'utf8'),
    ) as { steps: Array<{ id: string; command?: string }> };

    const canonicalById = new Map(canonical.steps.map((s) => [s.id, s.command]));
    for (const step of flow.steps) {
      if (step.command === undefined) continue;
      expect(canonicalById.get(step.id), `step "${step.id}" diverges from the canonical spec`).toBe(
        step.command,
      );
    }
  });

  it('gives every canonical step the same field set, in the kernel\'s own names', () => {
    // Comparing only `command` was not enough. PR #30 regenerated this file by
    // copying `dependsOn` straight from the yaml, but the kernel reads
    // `depends_on` — so the step that change added reached the kernel with no
    // dependencies, no retry policy, no verification and no iteration cap,
    // while two other steps carried a stray camelCase key alongside the real
    // one. Every command matched, so the check above passed throughout. PR #35
    // cleaned it up; this is the guard that would have caught it.
    //
    // The rule is shape, not content: whatever fields the kernel-authored
    // steps carry, every step must carry, and no step may carry an authoring
    // -surface alias the kernel does not read.
    const root = join(__dirname, '..', '..', '..');
    const canonical = JSON.parse(
      readFileSync(join(root, 'testdata', 'backlog-picker.spec.canonical.json'), 'utf8'),
    ) as { steps: Array<Record<string, unknown>> };

    expect(canonical.steps.length).toBeGreaterThan(1);
    const fieldSets = canonical.steps.map((step) => Object.keys(step).sort().join(','));
    const expected = fieldSets[0];
    canonical.steps.forEach((step, index) => {
      expect(
        fieldSets[index],
        `step "${String(step['id'])}" has a different field set than "${String(canonical.steps[0]?.['id'])}"`,
      ).toBe(expected);
    });

    // camelCase is the authoring surface's spelling; the kernel reads snake_case.
    for (const step of canonical.steps) {
      const camel = Object.keys(step).filter((key) => /[a-z][A-Z]/.test(key));
      expect(camel, `step "${String(step['id'])}" carries authoring-surface keys`).toEqual([]);
    }
  });

  it('carries every dependency the yaml declares, under the kernel\'s key', () => {
    // Consistency between steps is not enough, and review caught that (PR #37):
    // if regeneration dropped `depends_on` from EVERY step, all field sets
    // would still match and none would be camelCase, so both checks above pass
    // while the kernel silently loses the whole dependency graph and runs the
    // steps in the wrong order.
    //
    // So compare against the authority instead of against the siblings. The
    // yaml declares the dependencies; the canonical spec must carry the same
    // ones under `depends_on`. This cannot go stale as the kernel's schema
    // grows, because it asserts a relationship rather than a field list.
    const root = join(__dirname, '..', '..', '..');
    const flow = load(readFileSync(join(root, 'testdata', 'backlog-picker.flow.yaml'), 'utf8')) as {
      steps: Array<{ id: string; dependsOn?: string[] }>;
    };
    const canonical = JSON.parse(
      readFileSync(join(root, 'testdata', 'backlog-picker.spec.canonical.json'), 'utf8'),
    ) as { steps: Array<{ id: string; depends_on?: string[] }> };

    const canonicalById = new Map(canonical.steps.map((step) => [step.id, step]));
    let declared = 0;
    for (const step of flow.steps) {
      if (step.dependsOn === undefined) continue;
      declared += 1;
      expect(
        canonicalById.get(step.id)?.depends_on,
        `step "${step.id}" loses the dependencies the yaml declares`,
      ).toEqual(step.dependsOn);
    }
    // If the yaml ever stops declaring dependencies this test would assert
    // nothing at all, and pass while proving nothing.
    expect(declared, 'the flow yaml declares no dependencies to check').toBeGreaterThan(0);
  });

  it('keeps directories and extensionless paths, and rejects prose', () => {
    const steps = stepCommands();
    const dir = mkdtempSync(join(tmpdir(), 'backlog-scope-'));
    try {
      mkdirSync(join(dir, 'ops'), { recursive: true });
      writeFileSync(
        join(dir, 'ops', 'BACKLOG.md'),
        '# Backlog\n\n- **Scope entry** touches `regressions/` and `src/Dockerfile` and `ops/BACKLOG.md`,\n' +
          '  but a path that merely contains `/` is prose, not a file, and `the scope is parsed` is the goal.\n',
      );
      run(steps['read-backlog'], dir);
      run(steps['select-entry'], dir);
      const emitted = JSON.parse(run(steps['emit-package'], dir)) as { files_in_scope: string[] };

      expect(emitted.files_in_scope).toContain('regressions/');
      expect(emitted.files_in_scope).toContain('src/Dockerfile');
      expect(emitted.files_in_scope).toContain('ops/BACKLOG.md');
      expect(emitted.files_in_scope).not.toContain('/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
