import { expect, it } from 'vitest';
import { COMPLETION_DETAIL_MAX_CODE_POINTS, type Ctx, type DoneOptions } from '../src/index.js';

// The authoring contract, checked by the compiler. The one-argument call is
// first because it is the one every existing flow makes: adding an optional
// second parameter must not make any of them stop type-checking.
const author = (f: Ctx): void => {
  f.done('step_failed');
  f.done('step_failed', {});
  f.done('step_failed', { detail: undefined });
  f.done('step_failed', { detail: 'review found 1 P2: `review.clean` was not created' });
  f.done('needs_human', { detail: 'the allocation is ambiguous' });
  f.done('declined', { detail: 'no ticket in the input' });
  f.done('success', { detail: 'all three sweeps clean' });
  // @ts-expect-error a detail is prose, not a number
  f.done('step_failed', { detail: 5 });
  // @ts-expect-error the options are an object, not the detail itself
  f.done('step_failed', 'review found 1 P2');
  // @ts-expect-error unknown option
  f.done('step_failed', { reason: 'review found 1 P2' });
  // @ts-expect-error done takes at most two arguments
  f.done('step_failed', {}, {});
  // @ts-expect-error step-only reason, unchanged by the new argument
  f.done('verification_failed', { detail: 'x' });
};
void author;

const options: DoneOptions = { detail: 'exported for authors who build one' };
void options;

it('publishes the detail bound authors are held to', () => {
  expect(COMPLETION_DETAIL_MAX_CODE_POINTS).toBe(2000);
});
