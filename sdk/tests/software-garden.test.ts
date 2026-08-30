import { describe, expect, it } from 'vitest';
import { softwareGarden, toKernelSpec } from '../src/index.js';

const base = {
  name: 'relayflows-garden',
  repository: 'relayflows/relayflows',
  issueLabel: 'garden-ready',
  implementer: 'codex',
  reviewer: 'claude',
};

describe('Software Garden', () => {
  it('compiles labeled issue through reviewed PR without exposing kernel machinery', () => {
    expect(Object.keys(base)).toEqual([
      'name', 'repository', 'issueLabel', 'implementer', 'reviewer',
    ]);
    const flow = softwareGarden(base);

    expect(flow.triggers).toEqual([expect.objectContaining({
      eventType: 'github.issue.labeled',
      pattern: { repository: base.repository, label: base.issueLabel },
    })]);
    expect(flow.steps.map(({ id }) => id)).toEqual([
      'discover-issue', 'implement-and-open-pr', 'review-pr',
    ]);
    expect(flow.steps[2]).toMatchObject({
      dependsOn: ['implement-and-open-pr'],
      maxIterations: 3,
      verification: { type: 'output_contains', value: 'APPROVED' },
    });
    expect(toKernelSpec(flow).steps.every((step) => step.retry !== undefined)).toBe(true);
  });

  it('adds merge only with explicit opt-in', () => {
    expect(softwareGarden(base).steps.some(({ id }) => id === 'merge-pr')).toBe(false);
    expect(softwareGarden({ ...base, autoMerge: false }).steps.some(({ id }) => id === 'merge-pr')).toBe(false);
    expect(softwareGarden({ ...base, autoMerge: true }).steps.at(-1)).toMatchObject({
      id: 'merge-pr',
      dependsOn: ['review-pr'],
    });
  });

  it('fails closed on incomplete customer configuration', () => {
    expect(() => softwareGarden({ ...base, reviewer: '' })).toThrow(
      'Software Garden reviewer must be a non-empty string',
    );
  });
});
