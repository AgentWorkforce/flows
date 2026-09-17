import { flow } from "@relayflows/surface";

type Input = {
  /** Fresh, isolated Flows worktree. */
  repoRoot: string;
  /** Number of independent review-and-fix passes after the implementation slices. */
  auditPasses: number;
};

const safety = `
Work only in the supplied fresh worktree. Do not touch a shared checkout or a
different repository. Do not run git push, gh, wrangler, npm publish, a deploy,
or alter credentials, environment secrets, or remote configuration. Never
merge. You may make focused local commits after each green implementation
slice. Preserve existing unrelated work. Report exact commands, exit codes,
commit IDs, and any blocker in docs/evidence/event-await-implementation/.
`;

const contract = `
Implement docs/EVENT-AWAIT.md as the source of truth. The required public
contract is body-level f.on() returning an Activity with next()/close(), with
required idle and deadline, optional settle and includeSelf. f.on() becomes
visible only after a durable fenced binding and ingress offset. Delivery is
ordered, deduplicated, and buffered while the body works. Cap unread data at
1,000 frames or 1 MiB; the would-exceed frame is refused and next() observes
overflow. Router appends, idle/deadline claims, and overflow closure serialize
per subscription. Idle returns buffered events; deadline wins an exact tie and
reports unread pending data. Recovery preserves a committed normal completion
once, otherwise completes a fenced overflow closure without reopening it.
Read the full document, especially acceptance cases 1–15. Do not weaken its
contract or replace crash tests with mocks that bypass journal recovery.
`;

export default flow<Input>("event-await-flows-overnight", {
  budget: { dollars: 80, wallclock: "10h" },
}, async (f, input) => {
  await f.agent("event-await-surface-and-preflight", {
    cli: "codex",
    task: `${safety}\n${contract}\n
Own the Surface and SDK authoring slice. Inspect the existing authored-flow
lowering path, Ctx types, validation, generated schemas, and direct-run
executor before changing code. Implement the smallest additive Activity API,
lowering, validation, and result decoding needed by the contract. Add focused
type and runtime tests for missing idle/deadline, Wake variants, and lifecycle
closure. Do not claim kernel/router behavior you have not implemented. Run the
most focused relevant test and typecheck commands, record their outputs, then
commit only your local slice if it is green.`,
  });

  await f.agent("event-await-kernel-and-timers", {
    cli: "codex",
    task: `${safety}\n${contract}\n
Own the Rust kernel and local daemon slice. First inspect the previous Surface
slice and current journal/state/recovery/timer machinery. Implement durable
subscription open/close, stream-backed waits, offset acknowledgement,
per-subscription ordering, timeout arming, and restart recovery. Keep the
closed step vocabulary intact as the spec requires. Add crash-injection and
state-machine tests that exercise accepted append, idle/deadline ties, and the
overflow fence/close boundary. Run focused cargo tests and commit a green
local slice. If an interface belongs in Cloud rather than the kernel, document
the exact transport boundary rather than inventing tenant policy here.`,
  });

  await f.agent("event-await-local-router-and-acceptance", {
    cli: "codex",
    task: `${safety}\n${contract}\n
Integrate the completed local Surface and kernel slices through the local
event path. Implement only repository-owned adapters needed to exercise the
contract without Cloud credentials. Add the deterministic acceptance harness
for all fifteen cases, including process kill/restart, redelivery dedupe,
unread accounting, normal-completion-versus-overflow ordering, and refusal of
events after close. Test actual journal replay rather than only pure helpers.
Run the relevant SDK and kernel suites and commit the green local slice. Write
a precise Cloud handoff describing any production router operations still
outside this repository.`,
  });

  for (let pass = 1; pass <= input.auditPasses; pass += 1) {
    await f.agent(`event-await-flows-audit-${pass}`, {
      cli: "codex",
      task: `${safety}\n${contract}\n
Perform independent implementation audit pass ${pass}. Review every local
commit and test added for EVENT-AWAIT against acceptance cases 1–15 and the
existing kernel invariants. Fix concrete defects you find, especially replay,
idempotency, timer ordering, byte accounting, cleanup, and public API
compatibility. Run the narrowest meaningful regression suites plus the full
affected package suites. Commit only real fixes; otherwise write a no-finding
report with the commands and exit codes.`,
    });
  }

  await f.agent("event-await-flows-evidence", {
    cli: "codex",
    task: `${safety}\n${contract}\n
Act as release evidence owner. Do not change implementation semantics. Inspect
the final local branch, run the comprehensive relevant test matrix, and write
docs/evidence/event-await-implementation/final-local-report.md. It must map
each acceptance case to its test and literal result, list all local commits,
and distinguish proven local behavior from the Cloud router handoff. Commit
that evidence only when its commands all pass; otherwise record the exact
failure and leave it visible for the next human.`,
  });

  f.done("needs_human");
});
