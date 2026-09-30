import { expectTypeOf, it } from 'vitest';
import { type Activity, type Ctx, type EventFrame, type Wake, webhook } from '@relayflows/surface';

it('exposes a bounded body-level Activity and every Wake variant', () => {
  const body = (f: Ctx): Activity => f.on(webhook('pull_request'), {
    settle: '2m', idle: '72h', deadline: '14d', includeSelf: false,
  });
  void body;

  expectTypeOf<ReturnType<Ctx['on']>>().toEqualTypeOf<Activity>();
  expectTypeOf<ReturnType<Activity['next']>>().toEqualTypeOf<Promise<Wake>>();
  expectTypeOf<Extract<Wake, { kind: 'events' }>['events']>().toEqualTypeOf<readonly EventFrame[]>();

  const missingIdle = (f: Ctx) => {
    // @ts-expect-error idle is a required bound.
    return f.on(webhook('pull_request'), { deadline: '14d' });
  };
  const missingDeadline = (f: Ctx) => {
    // @ts-expect-error deadline is a required bound.
    return f.on(webhook('pull_request'), { idle: '72h' });
  };
  void missingIdle;
  void missingDeadline;
});
