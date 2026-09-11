import { flow } from '@relayflows/surface';
import { describe, expect, it, vi } from 'vitest';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { compileSpec, kernelToAuthoring, parseStepTimeout, toKernelSpec } from '../src/compile.js';
import { JournalClient } from '../src/journal-client.js';
import { chainFixture } from './flow-chain-fixture.js';

const commandSpec = (lease_ms?: number) => ({
  version: '0.1.0', steps: [{ id: 'cmd', type: 'deterministic', command: 'true',
    ...(lease_ms === undefined ? {} : { lease_ms }) }],
});

describe('deterministic step lease compilation', () => {
  it.each([
    ['5m', 300_000], [300_000, 300_000], ['10s', 10_000], ['250ms', 250],
    ['1.5s', 1500], ['15m', 900_000], [900_000, 900_000],
    // Bugbot #350 regression: fractional coefficients that hit float
    // precision (1.1 * 1000 = 1100.0000000000002) must round to a clean
    // integer, not be rejected as non-safe-integer.
    ['1.1s', 1100], ['2.2s', 2200], ['1.1m', 66_000],
    ['0.5s', 500], ['14.999m', 899_940],
    // Explicit coefficient-vs-unit ordering — a regression that swapped
    // match[1]/match[2] would produce 1000 (units["s"]) * 5 (coefficient
    // read as unit) = NaN. The row below fails hard on that specific bug.
    ['5s', 5000],
  ])('parses %s as %i milliseconds', (timeout, expected) => {
    expect(parseStepTimeout(timeout)).toBe(expected);
    const kernel = toKernelSpec(compileSpec(commandSpec(expected)));
    expect(kernel.steps[0]).toHaveProperty('lease_ms', expected);
    expect(toKernelSpec(compileSpec(kernelToAuthoring(kernel)))).toEqual(kernel);
  });

  it.each(['15.001m', '16m', 900_001])('refuses %s before contacting the journal', async timeout => {
    await expect(executeAuthoredFlow(flow('too-long', async f => {
      await f.run('true', { timeout });
      f.done('success');
    }), new JournalClient('/must-not-connect'))).rejects.toMatchObject({ kind: 'lease_exceeded' });
  });

  it.each([0, -1, NaN, Infinity, 0.5, '', '5', 'forever', '-1s', '0.0001s', null, {}])(
    'refuses invalid timeout %s', timeout => {
      expect(() => parseStepTimeout(timeout)).toThrow(/positive whole number/);
    },
  );

  it('enforces the ceiling for direct specs and omits an unspecified lease', () => {
    expect(() => compileSpec(commandSpec(900_001))).toThrow(/maximum of 15 minutes/);
    expect(toKernelSpec(compileSpec(commandSpec())).steps[0]).not.toHaveProperty('lease_ms');
  });
});

describe('deterministic step lease lowering', () => {
  function journalStub(reason = 'success') {
    const journal = new JournalClient('/unused');
    const starts = vi.spyOn(journal, 'runStart').mockImplementation(async () => ({
      run_id: `run-${starts.mock.calls.length}`, status: reason === 'success' ? 'completed' : 'failed',
      completion_reason: reason === 'success' ? 'success' : 'step_failed', completed_steps: 1,
    }));
    vi.spyOn(journal, 'journalRead').mockImplementation(async () => ({ entries: [{
      entry_type: 'step.completed', step_id: starts.mock.calls.at(-1)![0].steps[0]!.id,
      payload: { completionReason: reason, output: reason === 'success' ? { stdout_tail: 'ok' } : null },
    }] }));
    return { journal, starts };
  }

  it('snapshots each invocation and preserves defaults for later commands', async () => {
    const { journal, starts } = journalStub();
    await executeAuthoredFlow(flow('per-invocation', async f => {
      const options = { timeout: '5m' };
      const step = f.run('long command', options);
      options.timeout = '1ms';
      expect(await step).toBe('ok');
      await f.run('default command');
      await f.run('empty options', {});
      await f.run('numeric timeout', { timeout: 10_000 });
      f.done('success');
    }), journal);
    expect(starts.mock.calls.map(([spec]) => {
      const step = spec.steps[0]!;
      return 'lease_ms' in step ? step.lease_ms : undefined;
    })).toEqual([300_000, undefined, undefined, 10_000, undefined]);
  });

  it.each(['timeout', 'lease_expired'])('exposes %s as lease_exceeded with the journal reason', async reason => {
    const { journal } = journalStub(reason);
    await expect(executeAuthoredFlow(flow('expired', async f => {
      await f.run('slow command', { timeout: '10s' });
      f.done('success');
    }), journal)).rejects.toMatchObject({ code: 'lease_exceeded', completionReason: reason, runId: 'run-1' });
  });
});

describe('f.run leases against the live kernel', () => {
  // These wall-clock cases deliberately cross the former 30s limit; a smaller
  // mocked lease would not detect the executor's independent default timeout.
  it.each([
    { command: 'sleep 5; printf ok', timeout: '10s', lease: 10_000, succeeds: true },
    { command: 'sleep 31; printf ok', timeout: '40s', lease: 40_000, succeeds: true },
    { command: 'sleep 31; printf ok', timeout: undefined, lease: 30_000, succeeds: false },
    { command: 'sleep 5', timeout: 100, lease: 100, succeeds: false },
  ])('enforces $lease ms for $command', async ({ command, timeout, lease, succeeds }) => {
    const fixture = chainFixture();
    try {
      const journal = await fixture.connect();
      let output: string | undefined;
      const handle = flow('step-lease', async f => {
        output = await (timeout === undefined ? f.run(command) : f.run(command, { timeout }));
        f.done('success');
      });
      const started = Date.now();
      const execution = executeAuthoredFlow(handle, journal);
      let runId: string;
      if (succeeds) {
        const result = await execution;
        expect(output).toBe('ok');
        runId = result.journalSteps[0]!.runId;
      } else {
        const error = await execution.then(() => { throw new Error('expected lease refusal'); }, error => error);
        expect(error).toMatchObject({ code: 'lease_exceeded', completionReason: 'timeout' });
        expect(Date.now() - started).toBeGreaterThanOrEqual(lease);
        expect(Date.now() - started).toBeLessThan(lease + 5000);
        runId = error.runId;
      }
      const entries = (await journal.journalRead(runId, 1)).entries as Array<{
        entry_type: string; at_ms: number; payload: Record<string, unknown>;
      }>;
      const attempt = entries.find(entry => entry.entry_type === 'step.attempt.started')!;
      expect(attempt).toBeDefined();
      expect(attempt.payload.lease_deadline_ms).toBe(attempt.at_ms + lease);
      const completed = entries.find(entry => entry.entry_type === 'step.completed')!;
      expect(completed.payload.completionReason).toBe(succeeds ? 'success' : 'timeout');
    } finally {
      await fixture.close();
    }
  }, 45_000);
});
