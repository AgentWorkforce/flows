import { describe, expect, it, vi } from 'vitest';
import { validateNextWorkPackage } from '../src/work-package-validator.js';

const PR_19_NEXT = `# NEXT — finish the HN poller

Scope is defined by \`ops/TARGET.md\`.

## Definition of done

All three tests pass.
`;

const PR_35_NEXT = `# NEXT — repair the canonical backlog-picker spec

The canonical spec and YAML are now merged and tested.

Files in scope: \`testdata/backlog-picker.spec.canonical.json\`.
`;

describe('NEXT.md work-package validation', () => {
  it('refuses the PR #19 artifact for its first typed defect', () => {
    expect(validateNextWorkPackage(PR_19_NEXT, () => false)).toEqual({
      accepted: false,
      reason: 'nonexistent_repo_path',
    });
  });

  it('refuses the PR #19 test claim when its cited path exists', () => {
    expect(validateNextWorkPackage(PR_19_NEXT, () => true)).toEqual({
      accepted: false,
      reason: 'test_claim_without_evidence',
    });
  });

  it('refuses the PR #35 artifact because its test claim has no transcript', () => {
    expect(validateNextWorkPackage(PR_35_NEXT, () => true)).toEqual({
      accepted: false,
      reason: 'test_claim_without_evidence',
    });
  });

  it('accepts a well-formed package with captured command output', () => {
    const markdown = `# NEXT — validate work packages

Files in scope: \`sdk/src/work-package-validator.ts\`.

The SDK tests pass locally:

\`\`\`text
$ cd sdk && npm test
Test Files  16 passed (16)
Tests  84 passed (84)
\`\`\`
`;

    expect(validateNextWorkPackage(markdown, (path) => path === 'sdk/src/work-package-validator.ts'))
      .toEqual({ accepted: true });
  });

  it('does not mistake a definition-of-done requirement for a passing claim', () => {
    expect(validateNextWorkPackage('## Definition of done\n\nAll SDK tests must pass.', () => true))
      .toEqual({ accepted: true });
  });

  it('uses the injected pathExists check for every repo-path reference', () => {
    const pathExists = vi.fn((path: string) => path !== 'ops/missing.md');
    const markdown = 'Change `sdk/src/index.ts` as specified by `ops/missing.md`.';

    expect(validateNextWorkPackage(markdown, pathExists)).toEqual({
      accepted: false,
      reason: 'nonexistent_repo_path',
    });
    expect(pathExists.mock.calls).toEqual([
      ['sdk/src/index.ts'],
      ['ops/missing.md'],
    ]);
  });

  it('accepts a requirement, and still refuses a bare claim', () => {
    // Review found this on PR #50: the modal exemption keyed only on the word
    // "pass", so "must be green" read as an unevidenced claim and every work
    // package written to this repo's own brief format was refused — the
    // definition-of-done section is a list of requirements by construction.
    const requirement = [
      '# NEXT',
      '',
      '**Scope:** `sdk/src/preflight.ts`',
      '',
      '## Definition of done',
      '- `cd sdk && npm test` must be green',
      '- every new test confirmed to fail first',
    ].join('\n');
    expect(validateNextWorkPackage(requirement, () => true).accepted).toBe(true);

    const claim = ['# NEXT', '', 'Three tests pass and the flow is verified.'].join('\n');
    const verdict = validateNextWorkPackage(claim, () => true);
    expect(verdict.accepted).toBe(false);
    expect(verdict.accepted === false && verdict.reason).toBe('test_claim_without_evidence');
  });
});
