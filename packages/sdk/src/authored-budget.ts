import { BudgetSyntaxError, parseBudget, toKernelBudget } from './budget.js';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';
import type { JournalClient } from './journal-client.js';
import type { RunOutcome } from './protocol.js';
import type { KernelBudgetSpec, KernelRunSpec } from './spec.js';

/** Serialized admission for the internal authored runner's separate step runs. */
export class AuthoredBudget {
  private readonly limit: KernelBudgetSpec | undefined;
  private failed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private charges: { input: bigint; output: bigint; micro: bigint; ms: bigint; day: number }[] = [];

  constructor(header: unknown) {
    try {
      this.limit = header === undefined ? undefined : toKernelBudget(parseBudget(header));
    } catch (error) {
      if (error instanceof BudgetSyntaxError) throw new AuthoredFlowExecutionError('budget_syntax_invalid', error.message);
      throw error;
    }
  }

  async execute<T>(journal: JournalClient, spec: KernelRunSpec, consume: (outcome: RunOutcome) => Promise<T>): Promise<T> {
    if (this.limit === undefined) return consume(await journal.runStart(spec));
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      if (this.failed) throw new AuthoredFlowExecutionError('step_failed', 'A prior budgeted step did not finish successfully.');
      // Window selection follows journal timestamps, never the SDK host clock.
      const day = this.charges.at(-1)?.day;
      const total = this.charges.filter(c => this.limit!.window !== 'day' || c.day === day)
        .reduce((s, c) => ({ input: s.input + c.input, output: s.output + c.output, micro: s.micro + c.micro, ms: s.ms + c.ms }),
          { input: 0n, output: 0n, micro: 0n, ms: 0n });
      const exactNumber = (n: bigint) => { if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('budget counter overflow'); return Number(n); };
      const outcome = await journal.runStart({ ...spec, budget: { ...this.limit, prior_spend: {
        tokens_in: exactNumber(total.input), tokens_out: exactNumber(total.output),
        dollars: `${total.micro / 1_000_000n}.${String(total.micro % 1_000_000n).padStart(6, '0')}`,
        wallclock_ms: exactNumber(total.ms), ...(this.limit.window === 'day' && day !== undefined ? { day } : {}),
      } } });
      try {
        if (outcome.completion_reason === 'budget_exceeded') throw new AuthoredFlowExecutionError('step_failed', 'Flow budget exceeded before the next step.', 'budget_exceeded', outcome.run_id);
        return await consume(outcome);
      } finally {
        let seq = 1;
        for (;;) {
          const { entries } = await journal.journalRead(outcome.run_id, seq);
          if (entries.length === 0) break;
          for (const raw of entries) {
            const e = raw as {seq: number; entry_type: string; at_ms: number; payload: {budget?: {tokens_in: number; tokens_out: number; dollars: string}; spend?: {wallclock_ms: number}}};
            seq = e.seq + 1;
            if (!['step.completed', 'memory.injected'].includes(e.entry_type)) continue;
            const b = e.payload.budget;
            if (b === undefined) throw new Error('journal completion missing budget');
            const [whole, fraction = ''] = b.dollars.split('.');
            if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) throw new Error('budget accounting requires microdollar precision');
            this.charges.push({input: BigInt(b.tokens_in), output: BigInt(b.tokens_out),
              micro: BigInt(whole!) * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, '0')),
              ms: BigInt(e.payload.spend?.wallclock_ms ?? 0), day: Math.floor(e.at_ms / 86_400_000)});
          }
        }
      }
    } catch (error) {
      this.failed = true;
      throw error;
    } finally { release(); }
  }
}
