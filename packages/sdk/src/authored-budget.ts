import { BudgetSyntaxError, parseBudget, toKernelBudget } from './budget.js';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';
import type { JournalClient } from './journal-client.js';
import type { RunOutcome } from './protocol.js';
import type { KernelBudgetSpec, KernelPriorSpend, KernelRunSpec } from './spec.js';

/**
 * One journaled charge, in the accumulator's exact integer form.
 *
 * `unmetered` mirrors the journal's `budget.dollars_unmetered`: the charge
 * spent tokens whose dollar cost is unknown, so its `micro` is a lower bound
 * and not a measured amount. It is carried, not derived from `micro`, because
 * an unmetered charge and a genuinely free charge both report zero dollars.
 */
interface Charge {
  input: bigint;
  output: bigint;
  micro: bigint;
  ms: bigint;
  day: number;
  unmetered: boolean;
}

/** Serialized admission for the internal authored runner's separate step runs. */
export class AuthoredBudget {
  private readonly limit: KernelBudgetSpec | undefined;
  private failed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private charges: Charge[] = [];

  constructor(header: unknown) {
    try {
      this.limit = header === undefined ? undefined : toKernelBudget(parseBudget(header));
    } catch (error) {
      if (error instanceof BudgetSyntaxError) throw new AuthoredFlowExecutionError('budget_syntax_invalid', error.message);
      throw error;
    }
  }

  async execute<T>(journal: JournalClient, spec: KernelRunSpec,
    consume: (outcome: RunOutcome) => Promise<T>, admissionKey?: string): Promise<T> {
    if (this.limit === undefined) return consume(await journal.runStart(spec, undefined, admissionKey));
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      if (this.failed) throw new AuthoredFlowExecutionError('step_failed', 'A prior budgeted step did not finish successfully.');
      // Window selection follows journal timestamps, never the SDK host clock.
      const day = this.charges.at(-1)?.day;
      const total = this.charges.filter(c => this.limit!.window !== 'day' || c.day === day)
        .reduce((s, c) => ({ input: s.input + c.input, output: s.output + c.output, micro: s.micro + c.micro, ms: s.ms + c.ms,
          // Sticky, exactly as the kernel's running total is: once any charge
          // in the window was unmetered, the carried dollars are a lower bound.
          unmetered: s.unmetered || c.unmetered }),
          { input: 0n, output: 0n, micro: 0n, ms: 0n, unmetered: false });
      const exactNumber = (n: bigint) => { if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('budget counter overflow'); return Number(n); };
      // One explicit conversion to the shared carried-spend shape, so a new
      // accounting field is added here rather than silently dropped inline.
      const priorSpend: KernelPriorSpend = {
        tokens_in: exactNumber(total.input), tokens_out: exactNumber(total.output),
        dollars: `${total.micro / 1_000_000n}.${String(total.micro % 1_000_000n).padStart(6, '0')}`,
        wallclock_ms: exactNumber(total.ms),
        ...(this.limit.window === 'day' && day !== undefined ? { day } : {}),
        ...(total.unmetered ? { dollars_unmetered: true as const } : {}),
      };
      const outcome = await journal.runStart({ ...spec, budget: { ...this.limit, prior_spend: priorSpend } }, undefined, admissionKey);
      try {
        if (outcome.completion_reason === 'budget_exceeded') throw new AuthoredFlowExecutionError('step_failed', 'Flow budget exceeded before the next step.', 'budget_exceeded', outcome.run_id);
        return await consume(outcome);
      } finally {
        let seq = 1;
        for (;;) {
          const { entries } = await journal.journalRead(outcome.run_id, seq);
          if (entries.length === 0) break;
          for (const raw of entries) {
            const e = raw as {seq: number; entry_type: string; at_ms: number; payload: {budget?: {tokens_in: number; tokens_out: number; dollars: string; dollars_unmetered?: boolean}; spend?: {wallclock_ms: number}}};
            seq = e.seq + 1;
            if (!['step.completed', 'memory.injected'].includes(e.entry_type)) continue;
            const b = e.payload.budget;
            if (b === undefined) throw new Error('journal completion missing budget');
            const [whole, fraction = ''] = b.dollars.split('.');
            if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) throw new Error('budget accounting requires microdollar precision');
            this.charges.push({input: BigInt(b.tokens_in), output: BigInt(b.tokens_out),
              micro: BigInt(whole!) * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, '0')),
              ms: BigInt(e.payload.spend?.wallclock_ms ?? 0), day: Math.floor(e.at_ms / 86_400_000),
              unmetered: b.dollars_unmetered === true});
          }
        }
      }
    } catch (error) {
      this.failed = true;
      throw error;
    } finally { release(); }
  }
}
