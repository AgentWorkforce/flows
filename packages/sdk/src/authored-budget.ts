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

type Total = Omit<Charge, 'day'>;

/** `ms` as the budget header writes durations: `45s`, `2h`, `132.9m`. */
function duration(ms: bigint): string {
  const n = Number(ms);
  if (n < 60_000) return `${Number((n / 1000).toFixed(1))}s`;
  if (n % 3_600_000 === 0) return `${n / 3_600_000}h`;
  return `${Number((n / 60_000).toFixed(1))}m`;
}

const usd = (micro: bigint): string => `$${micro / 1_000_000n}.${String(micro % 1_000_000n).padStart(6, '0').replace(/0{1,4}$/, '')}`;

/**
 * Whether `micro` microdollars exceeds the decimal `limit`, compared exactly at
 * the limit's own precision (legacy `maxDollars` may carry more than six
 * decimals, which the kernel compares as written). Undefined if the limit is
 * not a plain decimal.
 */
function dollarsOver(micro: bigint, limit: string): boolean | undefined {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(limit);
  if (match === null) return undefined;
  const scale = Math.max(6, match[2]?.length ?? 0);
  const limitScaled = BigInt(match[1]! + (match[2] ?? '').padEnd(scale, '0'));
  return micro * 10n ** BigInt(scale - 6) > limitScaled;
}

/** Both durations, exact to the millisecond when rounding would print them equal. */
function durations(used: bigint, limit: bigint): [string, string] {
  const [u, l] = [duration(used), duration(limit)];
  return u === l ? [`${used}ms`, `${limit}ms`] : [u, l];
}

/**
 * The kernel refuses admission with only `budget_exceeded`; name which
 * declared limit the carried spend crossed and by how much, using the same
 * strict comparisons as `machine/budget.rs`. The kernel stays the authority: a
 * refusal this accumulator cannot explain keeps the generic wording.
 */
export function budgetExceededMessage(limit: KernelBudgetSpec, total: Total, spec?: KernelRunSpec): string {
  const crossed: string[] = [];
  if (limit.max_wallclock_ms !== undefined && total.ms > BigInt(limit.max_wallclock_ms)) {
    const [used, declared] = durations(total.ms, BigInt(limit.max_wallclock_ms));
    crossed.push(`wallclock ${used} used of ${declared} declared`);
  }
  if (limit.max_dollars !== undefined && dollarsOver(total.micro, limit.max_dollars) === true) {
    const exact = /^(\d+)(?:\.(\d{1,6}))?$/.exec(limit.max_dollars);
    const declared = exact === null ? `$${limit.max_dollars}`
      : usd(BigInt(exact[1]!) * 1_000_000n + BigInt((exact[2] ?? '').padEnd(6, '0')));
    crossed.push(`dollars ${usd(total.micro)}${total.unmetered ? ' metered (some steps unmetered)' : ''} used of ${declared} declared`);
  }
  if (limit.max_tokens !== undefined && total.input + total.output > BigInt(limit.max_tokens)) {
    crossed.push(`tokens ${total.input + total.output} used of ${limit.max_tokens} declared`);
  }
  if (limit.max_tokens_in !== undefined && total.input > BigInt(limit.max_tokens_in)) {
    crossed.push(`input tokens ${total.input} used of ${limit.max_tokens_in} declared`);
  }
  if (limit.max_tokens_out !== undefined && total.output > BigInt(limit.max_tokens_out)) {
    crossed.push(`output tokens ${total.output} used of ${limit.max_tokens_out} declared`);
  }
  const next = spec?.steps.length === 1 && typeof spec.steps[0]?.id === 'string' ? `step "${spec.steps[0].id}"` : 'the next step';
  if (crossed.length === 0) return `Flow budget exceeded before ${next}.`;
  const scope = limit.window === 'day' ? "in today's window of the flow's budget header" : "in the flow's budget header";
  return `Flow budget exceeded before ${next}: ${crossed.join('; ')} ${scope}.`;
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
        if (outcome.completion_reason === 'budget_exceeded') {
          throw new AuthoredFlowExecutionError('step_failed', budgetExceededMessage(this.limit!, total, spec), 'budget_exceeded', outcome.run_id);
        }
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
