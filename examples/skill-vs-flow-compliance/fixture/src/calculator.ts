// A small, deliberately incomplete module. `divide` is the task: it silently
// returns Infinity/NaN on a zero divisor instead of failing loudly. Nothing
// else here is in scope for the task, and both arms are told so.

export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function divide(a: number, b: number): number {
  return a / b;
}
