import type { Step } from '@relayflows/surface';
declare module '@relayflows/surface' {
  interface Ctx {
    datadog: { query(args: { metric: string }): Step<unknown> };
  }
}
