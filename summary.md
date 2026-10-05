# Refresh authoring documentation from the current surface

Authors can now find `f.run(command, options)` and its **30s default lease / 15m maximum** in the shipped README and generated `packages/surface/AUTHORING.md`. The limits were already correct in `docs/SURFACE.md`; this makes them discoverable and checked.

The reference includes all run overloads, six authored completion reasons (separate from kernel run and step reasons), `human(): Step<boolean>`, every `FlowHeader` and `AgentOptions` field, all five named gates, and 50 helper namespaces plus `f.mcp`. `f.slack` is one of the 50 helpers. `docs/CLI.md` derives all 24 commands, subcommands, arguments, options and literal defaults from `CLI_VERBS`. The root README and SURFACE guide link to the references; the stale CLI and gate descriptions are corrected.

Following `reviewed-plan.md`, generation reads canonical shipped `src/*.ts`, which `tsc` emits as `.d.ts`, preserving authored signatures and JSDoc without requiring a build. If built declarations exist, their export list is cross-checked. The AST reader follows named-gate union members even when not individually re-exported and refuses unresolved or environment-dependent CLI values. No API behavior changes.

`typecheck:regressions` now byte-compares both generated files and runs the new regression tests. Those independently read source text to check the issue's rows, check lease prose against the type comment, kernel default and compiler ceiling, and exercise rejection of changed/missing generated docs and acceptance after restoration. `AUTHORING.md` is included in the package's files list. Regenerate with `npm run gen:docs --prefix packages/surface`.

## Verification evidence

Commands ran from the repository root. Full captured output is committed at the linked paths; these are local results, not a claim of remote CI status.

`bash scripts/surface-package-gate.sh > /tmp/authoring-surface-gate.log 2>&1` — exit 0. [Full captured output](evidence/authoring-reference/surface-package-gate.log). The log includes the surface tests, new docs checks, SDK typecheck, packed runtime and TypeScript consumers, and SDK authored-flow tests. After the gate, CLI table rendering was adjusted to escape angle brackets in descriptions; the targeted tests and byte comparison below were rerun against that final change.

`node scripts/check-authoring-reference.mjs > evidence/authoring-reference/check.log 2>&1` — exit 0:

```text
AUTHORING_REFERENCE_OK
```

`node --test scripts/authoring-reference.test.mjs > /tmp/authoring-reference-tests.log 2>&1` — exit 0. Also saved as [tests.log](evidence/authoring-reference/tests.log):

```text
✔ extracts overloads in order and preserves lease JSDoc byte-for-byte (5.095847ms)
✔ walks union members even when not re-exported, including nested unions (1.222704ms)
✔ CLI literals refuse unresolved options with command and identifier (1.767566ms)
✔ CLI literals resolve imports, spreads, String and templates but refuse dynamic defaults (4.676176ms)
✔ run documents every exported overload and the lease comment (0.270881ms)
✔ done documents all three distinct completion vocabularies (0.709423ms)
✔ human returns Step<boolean> (0.113631ms)
✔ all helper namespaces and mcp are discoverable (0.468781ms)
✔ FlowHeader includes every field and its declaration (0.276151ms)
✔ AgentOptions includes every field and its declaration (0.24699ms)
✔ all named gate variants and both gate overloads are documented (0.26383ms)
✔ CLI includes every declared verb, subcommand and literal flag (0.640912ms)
✔ lease prose agrees with type, kernel default and compiler ceiling (0.775743ms)
✔ checker accepts exact docs, rejects drift or missing docs, and accepts restoration (1778.963914ms)
ℹ tests 14
ℹ suites 0
ℹ pass 14
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2007.258635
```

## Limits and follow-ups

- No workflow or gate script was edited. `surface-package.yml` watches
  `packages/surface/**`, `packages/sdk/**` and `regressions/**`, so every
  source behind a documented row — the surface types, `CLI_VERBS`, and the
  shipped reference itself — triggers the byte comparison. Edits only to
  `docs/CLI.md`, the root generation/test scripts, or prose outside the surface
  package do not trigger it. Run the check locally for those; extending the
  path filter is a follow-up.
- The lease number is guarded at both ends, which matters because the 30s lives
  in the kernel, and `kernel/**` is not a `surface-package.yml` path. The
  prose-sync test ties the surface JSDoc, `docs/SURFACE.md`, the surface README
  and `compile.ts`'s ceiling to `machine.rs`'s `LEASE_DURATION_MS`; the kernel
  separately pins its own default in
  `machine::tests::deterministic_lease_override_and_default_are_journaled`,
  which `cargo test --workspace` runs on any `kernel/**` change. Verified by
  mutation: setting `LEASE_DURATION_MS` to `60_000` fails the kernel test
  (`left: 61000, right: 31000`, `tests.rs:872`) and the prose-sync test
  (`✖ lease prose agrees with type, kernel default and compiler ceiling`,
  `fail 1`); restoring it byte-for-byte returns both to green (`2 passed`,
  `pass 14 / fail 0`) with a clean `git diff`. So a kernel-only change to the
  default cannot land while the docs still claim 30s.
- The external `@agent-relay/writing-relayflows` skill lives in `AgentWorkforce/skills`. Its refresh should derive from this reference; it was not changed here.
- `packages/create-flow/package.json` remains pinned to 2.0.8; changing that is a separate release decision.
- `ArtifactExistsNamedGate` is reachable through `NamedGate` but is not individually re-exported from the package root. This reference includes its shape without changing the API. The `ReadonlyFlowHeader` asymmetry also remains outside this documentation change.
