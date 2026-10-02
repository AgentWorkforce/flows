import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stepFailedFrame } from '../src/authored-node-runner.js';
import { transportEvidence } from '../src/cli-transport-evidence.js';
import {
  attemptFailure, compareAttempts, failureCause, renderAttemptHistory,
} from '../src/cli/step-evidence.js';
import type { StepFailedDetails } from '../src/failure-kinds.js';
import type { JournalClient } from '../src/journal-client.js';
import { AgentWorker } from '../src/worker.js';
import { runAgentCli } from '../src/worker-cli.js';

vi.mock('../src/worker-cli.js', () => ({ runAgentCli: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); });

// A process says why it died at the END of its stderr. A bound that keeps the
// head reports the noise that preceded the failure and drops the failure.
const NOISE = 'progress line\n'.repeat(400);
const FINAL = 'fatal: the actual reason this process died';

describe('bounded stderr keeps the diagnostic tail', () => {
  it('transport evidence keeps the last bytes and states the omission', () => {
    const evidence = transportEvidence({
      phase: 'close', cause: 'signal', exitCode: null, signal: 'SIGKILL', stderr: `${NOISE}${FINAL}`, retryable: true,
    }, {});
    expect(evidence.stderr_tail.endsWith(FINAL)).toBe(true);
    expect(evidence.stderr_tail).toMatch(/^\[transport stderr: \d+ bytes truncated\]…/u);
    expect(Buffer.byteLength(evidence.stderr_tail.replace(/^\[[^\]]*\]…/u, ''), 'utf8')).toBeLessThanOrEqual(2048);
  });

  it('the worker result keeps the tail, redacted against the CLI environment', async () => {
    const secret = 'step-only-credential-0123456789';
    const client = Object.assign(new EventEmitter(), {
      workerAttach: vi.fn(async () => ({})),
      stepHeartbeat: vi.fn(async () => ({ lease_deadline_ms: Date.now() + 30_000 })),
      stepComplete: vi.fn(async () => ({})),
      close: vi.fn(),
    });
    // Only the environment handed to the CLI holds this secret; the worker
    // host's process.env never saw it.
    expect(Object.values(process.env)).not.toContain(secret);
    const worker = new AgentWorker(client as unknown as JournalClient, {
      workerId: 'test', pins: { workspace: [], streams: [] },
      environment: { ...process.env, FLOWS_STEP_TOKEN: secret },
    });
    vi.mocked(runAgentCli).mockResolvedValue({
      exit_code: 1, stdout_tail: '', stderr_tail: `${NOISE}relay said ${secret}\n${FINAL}`,
    });
    await worker.attach();
    client.emit('step.dispatch', {
      run_id: 'run', step_id: 'step', attempt: 1, step_type: 'agent',
      spec: { cli: 'claude', instruction: 'hello' }, lease_id: 'lease',
      lease_deadline_ms: Date.now() + 30_000, idempotency_key: 'effect', pins: { workspace: [], streams: [] },
    });
    await worker.close();
    const completion = client.stepComplete.mock.calls[0]!.at(-1) as { output: { stderr_tail: string } };
    const stderr = completion.output.stderr_tail;
    expect(stderr.endsWith(FINAL)).toBe(true);
    expect(stderr).toMatch(/^\[worker stderr: \d+ bytes truncated\]…/u);
    expect(stderr).not.toContain(secret);
    expect(stderr).toContain('[redacted:FLOWS_STEP_TOKEN]');
  });
});

/** A worker-reported transport crash, as `step.completed` journals it. */
function crashed(stderr: string, signal = 'SIGKILL'): Record<string, unknown> {
  return {
    output: null,
    trajectory_tail: {
      transport: transportEvidence({
        phase: 'close', cause: 'signal', exitCode: null, signal: signal as NodeJS.Signals, stderr, retryable: true,
      }, {}),
    },
  };
}

describe('attempt comparison over bounded transport stderr', () => {
  it('cannot call two cut stderr streams unchanged on their surviving bytes', () => {
    // Different causes, same surviving tail and the same total length.
    const shared = `${NOISE}${FINAL}`;
    const first = failureCause('crashed', crashed(`${'a'.repeat(1000)}${shared}`));
    const second = failureCause('crashed', crashed(`${'b'.repeat(1000)}${shared}`));
    expect(first.key).toBe(second.key);
    expect(first.producerTruncated).toBe(true);
    expect(compareAttempts([first, second])).toBe('unknown');
  });

  it('still reports unchanged for complete, identical transport evidence', () => {
    const first = failureCause('crashed', crashed(FINAL));
    const second = failureCause('crashed', crashed(FINAL));
    expect(compareAttempts([first, second])).toBe('unchanged');
  });
});

describe('attempt history keeps transport metadata', () => {
  it('a signal crash with no stderr is not rendered as having no evidence', () => {
    const lost = attemptFailure(1, 'crashed', 'retry', crashed(''));
    expect(lost).toMatchObject({ signal: 'SIGKILL', transportCause: 'signal', transportPhase: 'close', retryableTransport: true });
    const rendered = renderAttemptHistory({
      attempts: [lost, attemptFailure(2, 'worker_error', 'step_done', crashed(FINAL, 'SIGTERM'))],
      attemptEvidence: 'differs',
    });
    expect(rendered).toContain('attempt 1: crashed signal=SIGKILL transport=signal phase=close retryable=true');
    expect(rendered).not.toContain('no failure evidence recorded');
  });
});

describe('authored runtime IPC carries transport evidence', () => {
  it('round-trips every transport field, terminal and historical', () => {
    const details: StepFailedDetails = {
      stepId: 'review', completionReason: 'worker_error', attempt: 2, maxIterations: 1,
      transportRetries: 3, transportPhase: 'close', transportCause: 'signal', signal: 'SIGKILL',
      errorCode: 'EAGAIN', retryableTransport: true,
      attempts: [
        {
          attempt: 1, completionReason: 'crashed', disposition: 'retry',
          transportPhase: 'spawn', transportCause: 'spawn_error', errorCode: 'EAGAIN', retryableTransport: true,
        },
        { attempt: 2, completionReason: 'worker_error', disposition: 'step_done', signal: 'SIGKILL' },
      ],
      attemptEvidence: 'differs',
    };
    expect(stepFailedFrame(details)).toEqual(details);
  });

  it('drops mistyped transport fields', () => {
    expect(stepFailedFrame({
      stepId: 'x', transportRetries: -1, signal: 9, retryableTransport: 'yes', transportCause: {},
    })).toEqual({ stepId: 'x' });
  });
});
