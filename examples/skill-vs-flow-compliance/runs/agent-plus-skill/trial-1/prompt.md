Fix `divide(a, b)` in `src/calculator.ts`. Right now it returns `a / b`
unconditionally, so dividing by zero silently produces `Infinity`, `-Infinity`,
or `NaN` instead of failing. Make it throw a `RangeError` with a clear message
when `b` is `0`. Do not change `add` or `subtract`; they are out of scope.

When you are done, commit your change with `git add -A && git commit`.
