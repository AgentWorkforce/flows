# Gate 5 — what a relayhistory-backed MemoryProvider has to do

Read of `AgentWorkforce/relayhistory` at `3e7df69`, 2026-09-08. RFC-0001 gate 5
says relayhistory is "consumed over its serialization contract, not rewritten",
so this records that contract rather than proposing a design that ignores it.

## What already exists on the flows side

`#220` landed the seam, and it is the part that is hard to retrofit (`kernel/MEMORY.md` is titled "Step memory, slice 1 (#220)"; #221 is a separate PR):
`MemoryProvider`, `MemoryPack`, and a `memory.injected` journal entry carrying
the consuming `step_id` and initial `attempt`. That is RFC decision 10 — memory
tokens charged to the consuming step, itemized, no shared pools.

What is wired is `FixedMemoryProvider`, which returns
`{"text":"fixed memory pack","citations":[]}` with synthetic usage of 7 input
tokens and `"0.002"`. `kernel/MEMORY.md` says so plainly: "a substrate stub:
there is no retrieval, relayhistory call, or claim about memory quality."

## The contract to consume

Retrieval is `ai-hist pack`:

    ai-hist pack <query...> [--project P] [--tag T] [--source S]
                            [--limit N] [--tokens N] [--fts] [--json]

- `--json` emits `{ "query": ..., "entries": [...] }`.
- `--tokens N` is the budget, applied as `chars_budget = tokens * 4`
  (`crates/ai-hist/src/lib.rs:2369`) — a four-characters-per-token
  approximation, not a tokenizer. A provider must not report that figure back
  as exact usage; decision 10's accounting is only checkable if the number
  means something.

**The trap worth writing down before anyone implements this.** `pack_entries`
calls `std::process::exit(1)` when there are no results, after printing
`{"query": ..., "entries": []}`. Exit 1 here means *no memory matched*, not
*the call failed*. A provider that treats nonzero as an error will report every
cold-start step as a memory failure, and a provider that treats it as fatal
will fail closed on exactly the runs that have nothing to remember yet.

The trajectory side is `ai-hist push`, which takes `--install-service` and an
interval. Gate 5's bar is "every relayflow run pushes trajectories to
relayhistory **without opt-in code**", so that is a service the cell runs, not
a call each flow makes.

## What gate 5 still needs, in order

1. A `RelayhistoryMemoryProvider` over `ai-hist pack --json`, mapping a step's
   declared `memory: { scope, query, budget }` onto the pack arguments and
   reporting honest usage rather than the char-budget approximation.

   **It does not live in the kernel.** The adapter belongs at the
   SDK/control-plane edge and reaches the kernel across the journal protocol
   boundary. RFC-0001 §4 and settled decision #13 keep the Rust kernel small,
   pure and closed-vocabulary, so `relayflowd` must not gain an `ai-hist`
   dependency, a subprocess call, or any relayhistory-shaped vocabulary.
   `MemoryProvider` in `kernel/relayflowd/src/memory.rs` stays an **injected
   protocol seam** — the kernel declares the shape it will accept and never
   learns who satisfies it. Reading item 1 as "implement this trait inside
   relayflowd" is the failure mode this paragraph exists to prevent.
2. Exit-1-means-empty handled explicitly, with a test that a step whose query
   matches nothing still runs and journals an empty pack.
3. The push side wired as a service.

None of this is the acceptance test. RFC gate 5 asks for "an agent avoiding a
mistake recorded in a previous run's trajectory, with the citation in its
output" — a behavioural bar, not a passing suite. The three items above are
what makes attempting it possible.
