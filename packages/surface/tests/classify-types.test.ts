import { expectTypeOf, it } from 'vitest';
import type { ClassifyResult, Ctx, Step } from '../src/index.js';

it('infers choices from criteria without widening them to the fallback', () => {
  function contract(f: Ctx) {
    const step = f.classify({ question: 'depth?', state: '', options: {
      small: 'tiny', standard: 'normal', deep: 'risky',
    }, fallback: 'deep' });
    expectTypeOf(step).toEqualTypeOf<Step<ClassifyResult<'small' | 'standard' | 'deep'>>>();
    // @ts-expect-error fallback must be one of the declared choices
    f.classify({ question: 'depth?', state: '', options: { small: 'tiny', deep: 'risky' }, fallback: 'huge' });
  }
  expectTypeOf(contract).toBeFunction();
});
