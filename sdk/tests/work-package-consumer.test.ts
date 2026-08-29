import { describe, expect, it } from 'vitest';

const validPackage = {
  title: 'Build the work package consumer',
  files_in_scope: ['sdk/src/', 'sdk/tests/'],
  definition_of_done: ['cd sdk && npm test'],
};

async function consume(input: unknown) {
  const module = await import('../src/work-package-consumer.js');
  return module.consumeWorkPackage(input);
}

describe('work package consumer', () => {
  it('refuses a missing title with a typed reason', async () => {
    const { title: _, ...input } = validPackage;
    expect(await consume(input)).toEqual({ accepted: false, reason: 'missing_title' });
  });

  it('refuses an empty title with a typed reason', async () => {
    expect(await consume({ ...validPackage, title: '   ' })).toEqual({
      accepted: false,
      reason: 'missing_title',
    });
  });

  it('refuses a missing scope with a typed reason', async () => {
    const { files_in_scope: _, ...input } = validPackage;
    expect(await consume(input)).toEqual({ accepted: false, reason: 'missing_scope' });
  });

  it('refuses an empty scope with a typed reason', async () => {
    expect(await consume({ ...validPackage, files_in_scope: [] })).toEqual({
      accepted: false,
      reason: 'missing_scope',
    });
  });

  it('refuses a missing definition of done with a typed reason', async () => {
    const { definition_of_done: _, ...input } = validPackage;
    expect(await consume(input)).toEqual({
      accepted: false,
      reason: 'missing_definition_of_done',
    });
  });

  it('refuses an empty definition of done with a typed reason', async () => {
    expect(await consume({ ...validPackage, definition_of_done: [] })).toEqual({
      accepted: false,
      reason: 'missing_definition_of_done',
    });
  });

  it('accepts a valid package as runnable work', async () => {
    expect(await consume(validPackage)).toEqual({ accepted: true, work: validPackage });
  });
});
