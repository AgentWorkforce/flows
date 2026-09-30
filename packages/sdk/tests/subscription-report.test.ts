import { describe, expect, it, vi } from 'vitest';
import { withSubscriptionMetadata } from '../src/cli/subscription-report.js';
import type { RunExecution } from '../src/cli/run.js';
import type { SubscriptionSnapshot } from '../src/protocol.js';

const active: SubscriptionSnapshot = {
  subscriptionId: 'activity-1', state: 'active', routerBinding: { generation: 'g1', repository: 'repo' },
  ingressOffset: 17, unreadFrames: 2, unreadBytes: 93, settleMs: 2000, idleAtMs: 30000, deadlineAtMs: 90000,
};
function execution(status: 'suspended' | 'parked' | 'completed' | 'failed'): RunExecution {
  return { exitCode: status === 'suspended' ? 4 : status === 'parked' ? 3 : status === 'failed' ? 1 : 0,
    report: { ok: status === 'completed', command: 'resume', runId: 'root', socketPath: '/socket', status,
      resolutions: [], diagnostics: [], ...(status === 'suspended' ? { suspension: {
        kind: 'event_wait' as const, subscriptionId: 'activity-1', stream: 'subscription/activity-1', deadlineAtMs: 90000,
      } } : {}) } };
}
describe('durable subscription report metadata', () => {
  it.each(['suspended', 'parked', 'completed', 'failed'] as const)('preserves the authoritative snapshot for %s', async status => {
    const snapshot = status === 'completed' || status === 'failed'
      ? { ...active, state: 'closed' as const, completionReason: status === 'completed' ? 'run_completed' as const : 'canceled' as const }
      : active;
    const inspect = vi.fn(async () => ({ subscriptions: [snapshot] }));
    const original = execution(status);
    const reported = await withSubscriptionMetadata(original, inspect);
    expect(inspect).toHaveBeenCalledWith('/socket', 'root');
    expect(reported.exitCode).toBe(original.exitCode);
    expect(reported.report.subscriptions).toEqual([snapshot]);
    expect(original.report.subscriptions).toBeUndefined();
  });
  it('inspects the root rather than a failed child diagnostic run', async () => {
    const failed = execution('failed');
    failed.report.runId = 'child';
    failed.report.rootRunId = 'root';
    const inspect = vi.fn(async () => ({ subscriptions: [{ ...active, state: 'closed' as const }] }));
    await withSubscriptionMetadata(failed, inspect);
    expect(inspect).toHaveBeenCalledWith('/socket', 'root');
  });
  it('keeps absolute idle/settle/deadline instants unchanged on repeated early wakes', async () => {
    const inspect = async () => ({ subscriptions: [active] });
    const first = await withSubscriptionMetadata(execution('suspended'), inspect);
    const resumed = await withSubscriptionMetadata(execution('suspended'), inspect);
    expect(first.report.suspension).toEqual({ kind: 'event_wait', subscriptionId: 'activity-1',
      stream: 'subscription/activity-1', settleMs: 2000, idleAtMs: 30000, deadlineAtMs: 90000 });
    expect(resumed.report.suspension).toEqual(first.report.suspension);
  });
  it('does not disguise missing durable timing or an inspect error as usable suspension', async () => {
    for (const inspect of [async () => ({ subscriptions: [] }), async () => { throw new Error('unavailable'); }]) {
      const reported = await withSubscriptionMetadata(execution('suspended'), inspect);
      expect(reported.exitCode).toBe(1);
      expect(reported.report.ok).toBe(false);
      expect(reported.report.suspension).toBeUndefined();
      expect(reported.report.subscriptions).toBeUndefined();
      expect(reported.report.diagnostics.at(-1)?.kind).toBe('protocol_error');
    }
  });
  it('does not contact the daemon when preflight never created a run', async () => {
    const inspect = vi.fn();
    const reported = await withSubscriptionMetadata({ exitCode: 2,
      report: { ok: false, command: 'run', diagnostics: [], resolutions: [] } }, inspect);
    expect(inspect).not.toHaveBeenCalled();
    expect(reported.report.subscriptions).toEqual([]);
  });
});
