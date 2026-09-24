// The `f.run` overload set for `onNonZero`, pinned at the type level.
//
// The whole feature is opt-in, so what matters most here is the NEGATIVE
// claim: an omitted or `'fail'` policy must keep resolving to `string`. If an
// overload ever widened the default to `string | RunResult`, every existing
// body that does `(await f.run(...)).trim()` would stop compiling — and the
// compiler is the only thing that can hold that line.

import type { Ctx, RunOptions, RunResult } from '../src/index.js';

export async function runPolicyOverloads(f: Ctx): Promise<void> {
  // The default, and the explicit spelling of the default, both stay `string`.
  // These annotations are the real assertion: a widened overload would resolve
  // to `string | RunResult`, which does not assign to `string`.
  const plain: string = await f.run('npm test');
  const timed: string = await f.run('npm test', { timeout: '5m' });
  const explicit: string = await f.run('npm test', { onNonZero: 'fail' });
  void [plain, timed, explicit];

  // The literal `'record'` — and only it — widens the result.
  const recorded: RunResult = await f.run('npm test', { onNonZero: 'record' });
  const ok: boolean = recorded.ok;
  const exitCode: number = recorded.exitCode;
  const streams: string[] = [recorded.output, recorded.stdout, recorded.stderr];
  void [ok, exitCode, streams];

  // A policy held in a VARIABLE matches neither literal overload, so the
  // author receives the union and has to narrow it. Silently picking one of
  // the two branches for them would be a guess about which one they meant.
  const chosen: RunOptions['onNonZero'] = Math.random() > 0.5 ? 'record' : 'fail';
  const union: string | RunResult = await f.run('npm test', { onNonZero: chosen });
  if (typeof union !== 'string') {
    const narrowed: number = union.exitCode;
    void narrowed;
  }

  // @ts-expect-error A recorded result is not a string, so the default's callers cannot be silently widened.
  const notAString: string = await f.run('npm test', { onNonZero: 'record' });
  void notAString;
  // @ts-expect-error The default resolves to a string, which has no exit code to read.
  void (await f.run('npm test')).exitCode;
  // @ts-expect-error The union must be narrowed before either branch is read.
  void (await f.run('npm test', { onNonZero: chosen })).exitCode;
  // @ts-expect-error `ignore` is not one of the two policies the kernel enum names.
  await f.run('npm test', { onNonZero: 'ignore' });
  // @ts-expect-error The policy is a string literal, not a boolean.
  await f.run('npm test', { onNonZero: false });
  // @ts-expect-error Unknown option keys are refused, as everywhere else on the surface.
  await f.run('npm test', { onNonzero: 'record' });

  // A declared gate does not change what the policy resolves to: a named gate
  // still yields the step's own result type on both sides.
  const gatedDefault: string = await f.run('npm test')
    .gate({ type: 'regex_match', pattern: 'ok', in_output_at: ['stdout_tail'] });
  const gatedRecord: RunResult = await f.run('npm test', { onNonZero: 'record' })
    .gate({ type: 'regex_match', pattern: 'ok', in_output_at: ['stdout_tail'] });
  void [gatedDefault, gatedRecord];

  // A predicate gate judges the value the author received, so its parameter
  // type follows the policy rather than being fixed at `string`.
  await f.run('npm test').gate((value) => value.trim().length > 0);
  await f.run('npm test', { onNonZero: 'record' }).gate((value) => value.exitCode === 0);
  // @ts-expect-error On a recording step the predicate sees a RunResult, not a string.
  await f.run('npm test', { onNonZero: 'record' }).gate((value) => value.trim() === '');
  // @ts-expect-error On a default step the predicate sees a string, which has no exit code.
  await f.run('npm test').gate((value) => value.exitCode === 0);
}
