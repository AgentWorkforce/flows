# dependency-upgrade-bot

**BLOCKED — not runnable on the current authored executor.** The candidate
CLI refuses the `budget` header before any step runs (exit 2, 5.138s).
[Exact command and captured output](../../docs/evidence/ws13/review/gallery/gallery-dependency-upgrade-bot.txt).
The SDK/kernel capability owner must supply budget-header support, postfix
artifact gates, and the declared workspace behavior before this example can
be advertised as working. Its existing requirements remain intact.

**Like I'm 5:** A checklist notices a library is out of date. A robot tries
upgrading it, but only in its own sandboxed corner where it can't break
anything real. A *second*, completely separate robot — in its own sandbox
that can't see the first robot's work except the summary — boots the
upgraded app and actually clicks through it like a real person would, to
make sure nothing broke. Only if that second robot is fully satisfied does
a pull request get opened. The upgrader saying "it works" counts for
nothing on its own.

## The shape

```
npm outdated (deterministic, gated) → upgrade (agent, sandbox A) → verify with computer use (agent, sandbox B, gated) → open PR (deterministic, gated) → done
```

`dependency-upgrade-bot.flow.ts` is written against the real
`@relayflows/surface` package. The point of this example is the
**independence** of the two agent steps:

- The deterministic first gate refuses to even start an upgrade if nothing
  is actually outdated — this isn't an agent's judgment call, it's
  `npm outdated`'s own exit data.
- `upgrader` and `verifier` are given **different workspaces**
  (`sandbox/upgrade` vs `sandbox/verify`). The verifier is deliberately never
  told to trust the upgrader's summary of what it did — its task tells it to
  boot the app and drive it itself.
- Both agent gates check for a **file the agent wrote**
  (`sandbox/upgrade/CHANGES.md`, `sandbox/verify/PASSED`), not a string in
  its response — an agent that says "all good!" without writing the marker
  fails closed, same lesson as the other two examples in this directory.
- The PR only opens after the verifier's gate passes, and the final gate
  checks that a real PR URL came back — not just that the `gh` command
  exited 0.

## Status: refused before execution

WS-13 invoked this example with the packed CLI and `--local-agent`. It
refused the unsupported `budget` header before entering the body. See the
[gallery](../README.md) for the exact command, output, and elapsed time.
The remaining limitations below describe what still needs to land after that
first refusal is resolved.

```sh
cd packages/surface && npm run typecheck:examples
```

- `--local-agent` attaches a stream-only worker; it cannot provide the
  workspace revision pins and isolation declared by this example.
- **The sandbox isolation is declared, not enforced.** RFC-0001 Appendix A
  rule 1 (workspace-scoped permissions) is gate-8 kernel work; today nothing
  stops the `upgrader` step from reading `sandbox/verify/` if the underlying
  CLI isn't sandboxed itself. This flow is written so that the moment gate 8
  lands, "separate sandbox" starts meaning it.
