import { flow } from '@relayflows/surface';
import { afterEach, describe, expect, it } from 'vitest';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { compileSpec, toKernelSpec } from '../src/compile.js';
import type { JournalClient } from '../src/journal-client.js';
import { attachLocalAgent } from '../src/local-agent.js';
import type { FlowSpec } from '../src/spec.js';
import { chainFixture } from './flow-chain-fixture.js';

/**
 * The acceptance the ticket asks for: what a lowered named gate leaves in the
 * JOURNAL, read back from a real daemon. `named-gate-diagnostics.test.ts`
 * proves the generated program writes the bytes; only these cases prove they
 * are persisted as the gate step's `output.stdout_tail` / `output.stderr_tail`
 * and survive a failed completion.
 */

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

interface Envelope { exit_code?: number; stdout_tail?: string; stderr_tail?: string }
interface Completion { completionReason: string; output: Envelope | null; verification?: { verdict?: string } }

/** The `step.completed` the kernel appended for one step, once it exists. */
async function completionOf(
  journal: JournalClient, runId: string, stepId: string, timeoutMs = 20_000,
): Promise<Completion> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { entries } = await journal.journalRead(runId, 1, 1000);
    const found = (entries as Array<{ entry_type: string; step_id?: string; payload: Completion }>)
      .find(entry => entry.entry_type === 'step.completed' && entry.step_id === stepId);
    if (found !== undefined) return found.payload;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`step.completed for "${stepId}" never arrived in ${runId}`);
}

function gatedSpec(command: string, name: string): FlowSpec {
  return compileSpec({
    version: '0.1.0', name,
    steps: [{
      id: 'produce', type: 'deterministic', command: "printf 'the reviewed text'",
      verification: { type: 'subprocess_gate', command, from_output: ['stdout_tail'] },
    }],
  });
}

describe('a lowered subprocess_gate journals the gate command\'s streams', () => {
  it('keeps both tails on a FAILING gate, the case the operator has nothing else for', async () => {
    const fixture = chainFixture();
    cleanup.push(() => fixture.close());
    const journal = await fixture.connect();

    const started = await journal.runStart(toKernelSpec(gatedSpec(
      "printf 'GATE_FAILED tree moved under me'>&2; printf 'GATE_STDOUT %s' \"$INPUT\"; exit 1",
      'gate-fails',
    )));
    const gate = await completionOf(journal, started.run_id, 'produce.gate');

    expect(gate.completionReason).toBe('retries_exhausted');
    expect(gate.output?.exit_code).toBe(1);
    expect(gate.output?.stderr_tail).toContain('GATE_FAILED tree moved under me');
    expect(gate.output?.stdout_tail).toContain('GATE_STDOUT the reviewed text');
  }, 30_000);

  it('keeps both tails on a PASSING gate, so a gate that passed for the wrong reason is inspectable', async () => {
    const fixture = chainFixture();
    cleanup.push(() => fixture.close());
    const journal = await fixture.connect();

    const started = await journal.runStart(toKernelSpec(gatedSpec(
      "printf 'GATE_PASSED %s' \"$INPUT\"; printf 'a note nobody reads on green'>&2",
      'gate-passes',
    )));
    const gate = await completionOf(journal, started.run_id, 'produce.gate');

    expect(gate.completionReason).toBe('success');
    expect(gate.output?.exit_code).toBe(0);
    expect(gate.output?.stdout_tail).toContain('GATE_PASSED the reviewed text');
    expect(gate.output?.stderr_tail).toContain('a note nobody reads on green');
  }, 30_000);

  it('journals the diagnostic when the gate never reached the command', async () => {
    const fixture = chainFixture();
    cleanup.push(() => fixture.close());
    const journal = await fixture.connect();

    const started = await journal.runStart(toKernelSpec(compileSpec({
      version: '0.1.0', name: 'gate-selection-missed',
      steps: [{
        id: 'produce', type: 'deterministic', command: "printf 'the reviewed text'",
        verification: {
          type: 'subprocess_gate', command: "printf 'THE-COMMAND-RAN'",
          from_output: ['review', 'verdict'],
        },
      }],
    })));
    const gate = await completionOf(journal, started.run_id, 'produce.gate');

    expect(gate.output?.exit_code).toBe(1);
    expect(gate.output?.stdout_tail).not.toContain('THE-COMMAND-RAN');
    expect(gate.output?.stderr_tail).toContain('subprocess_gate: from_output ["review","verdict"]');
  }, 30_000);

  it('persists what the gate printed before a timeout killed it', async () => {
    const fixture = chainFixture();
    cleanup.push(() => fixture.close());
    const journal = await fixture.connect();

    // A timeout is not propagated from the producer to the barrier, so it is
    // set on the compiled gate step directly. The point is the kernel's:
    // `inherit` puts the command's bytes in the capture pipe as they are
    // written, so SIGKILL to the process group cannot erase them.
    const spec = toKernelSpec(gatedSpec("printf 'GATE_PARTIAL before the wait'; sleep 30", 'gate-times-out'));
    const barrier = spec.steps.find(step => step.id === 'produce.gate');
    if (barrier?.type !== 'deterministic') throw new Error('the lowered gate must be a deterministic step');
    barrier.timeout_ms = 750;

    const started = await journal.runStart(spec);
    const gate = await completionOf(journal, started.run_id, 'produce.gate');

    expect(gate.completionReason).toMatch(/timeout|retries_exhausted/u);
    expect(gate.output?.stdout_tail).toContain('GATE_PARTIAL before the wait');
  }, 30_000);
});

describe('a gate on an agent step', () => {
  it('journals the command\'s streams and surfaces them in the authored failure', async () => {
    // The reported incident's shape: the gate follows an agent, so the
    // envelope it selects from is the worker's, not a deterministic step's.
    const fixture = chainFixture(JSON.stringify({ summary: 'drafted the section' }));
    cleanup.push(() => fixture.close());
    const journal = await fixture.connect();
    const agent = await attachLocalAgent(journal);
    cleanup.push(() => agent.close());

    const handle = flow('agent-then-gate', async (f) => {
      await f.agent('draft', { task: 'Draft the section.' })
        .gate({
          type: 'subprocess_gate',
          command: "printf 'GATE_FAILED missing signoff'>&2; printf 'GATE_SAW %s' \"$INPUT\"; exit 1",
        });
      f.done('success');
    });

    const failure = await executeAuthoredFlow(handle, journal, undefined, {
      flowPath: fixture.flowPath, localAgentStream: agent.stream, dataDir: fixture.data,
    }).then(() => undefined, (error: Error & { runId?: string }) => error);

    expect(failure, 'the failing gate must fail the flow').toBeDefined();
    // The failure report is where an operator meets this first: it must carry
    // the command's own account, not just "a gate failed".
    expect(failure!.message).toContain('GATE_FAILED missing signoff');

    const gate = await completionOf(journal, failure!.runId!, 'agent-1.gate');
    expect(gate.output?.exit_code).toBe(1);
    expect(gate.output?.stderr_tail).toContain('GATE_FAILED missing signoff');
    // No `from_output`: a non-deterministic producer's envelope is selected
    // whole, so the command is handed the serialized envelope rather than a
    // `stdout_tail` it does not have.
    expect(JSON.parse(gate.output!.stdout_tail!.replace('GATE_SAW ', '')))
      .toEqual({ summary: 'drafted the section' });
  }, 60_000);
});
