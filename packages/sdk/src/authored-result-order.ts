/**
 * Publish authored deterministic results in invocation order while their
 * journal requests run concurrently. Continuations allocate the next step id,
 * so exposing a later result first would make those ids depend on shell timing
 * and could bind a resumed child admission key to a different command.
 */
export class AuthoredResultOrder {
  private issued = 0;
  private next = 0;
  private readonly waiting = new Map<number, () => void>();

  reserve(): number {
    return this.issued++;
  }

  async run<T>(ticket: number, work: () => Promise<T>): Promise<T> {
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await work() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    if (ticket !== this.next) {
      await new Promise<void>(resolve => this.waiting.set(ticket, resolve));
    }
    this.next++;
    this.waiting.get(this.next)?.();
    this.waiting.delete(this.next);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
}
