# NEXT — gate 2 (proactive agent) is the frontier

Written by Khaliq's session on 2026-08-28, replacing the claim that gate 6 was
next up. That claim was not actionable, and the Lead was right to refuse it.

## What changed and why

The Lead escalated rather than guessing (run 43a8857f, `ops/NEEDS_HUMAN.md`):
RFC-0001 defines gate 6 as converting "the existing example flows", but this
repo has no example flows, no integration primitives and no `runner.ts` — those
live in the old engine. Gate 6's done-when could not be satisfied here.

**Khaliq's decision (option B):** gate 6 waits for gates 2-4, which bring the
example flows into this repo. Integration conversion then happens once, on the
final engine, and stays inside one repo.

**Carve-out:** the `f.slack` / `f.notion` helper surface may be built now. The
design partner needs it and it does not depend on old-engine flows. Building it
does NOT make gate 6 green — that needs the real workload running on it.

## The work package

**Gate 2 — the proactive agent.** An agent that wakes on an event rather than
being invoked, with context assembled per wake from an epoch summary plus the
triggering event (RFC-0001 Appendix A, and the "no session" answer for chief).

Definition of done: a flow declares an event subscription; the kernel wakes it
on a matching event; the agent step receives a context assembled at wake time
rather than a resumed session; the wake is journaled as a fact; and a test
proves a second identical event does not double-execute the effect.

Out of scope for this package: gates 3-9, and any gate-6 integration work
beyond the helper surface named above.
