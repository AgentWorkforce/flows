import { expect, it } from 'vitest';
import { COMPLETION_REASONS, RUN_COMPLETION_REASONS, FLOW_COMPLETION_REASONS, type Ctx } from '../src/index.js';

const author = (f: Ctx): void => {
  f.done('declined');
  // @ts-expect-error step-only reason
  f.done('verification_failed');
  // @ts-expect-error unknown reason
  f.done('no_op');
};
void author;

it('keeps authored declination out of kernel vocabularies', () => {
  expect(FLOW_COMPLETION_REASONS).toContain('declined');
  expect(COMPLETION_REASONS).not.toContain('declined');
  expect(RUN_COMPLETION_REASONS).not.toContain('declined');
});
