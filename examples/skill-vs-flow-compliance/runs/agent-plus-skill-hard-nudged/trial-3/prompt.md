Extend `src/calculator.ts` with four changes in one pass:

1. Fix `divide(a, b)`: it currently returns `a / b` unconditionally, so
   dividing by zero silently produces `Infinity`/`-Infinity`/`NaN`. Throw a
   `RangeError` with a clear message when `b` is `0`.
2. Add `average(nums: number[]): number` — the arithmetic mean. Throw a
   `RangeError` if `nums` is empty.
3. Add `power(base: number, exponent: number): number` — `base` raised to
   `exponent` for non-negative integer exponents. Throw a `TypeError` if
   `exponent` is negative or not an integer.
4. `add` and `subtract` currently accept anything typed `number`, including
   `NaN`. Make both throw a `TypeError` when either argument is `NaN`.

Do not change any function's name or parameter order. When you are done,
commit your work — use as many commits as you think make sense.


Before you start, check whether this repository has any installed project skills that apply to this kind of change, and use whatever applies.