# regressions — executable bug reports, red then green

Four platform bugs were found on 2026-08-27, during the first dogfood runs. Each
one is written here twice, in the flows v2 dialect (`docs/SURFACE.md`):

- **`<slug>.red.flow.ts`** — reproduces the failure. Its gates assert the
  **broken** behaviour, so it **passes while the bug is present**. This is the
  bug report, in a form a machine can re-run.
- **`<slug>.green.flow.ts`** — asserts the **corrected** behaviour. It **fails
  while the bug is present** and passes once it is fixed. This is the acceptance
  test.

A bug is closed when its red case starts failing and its green case starts
passing, in the same run. Either one alone can lie: a green test that never ran
red proves nothing about the bug it claims to cover.

## These flows do not run yet, and must not

Nothing in this directory is wired into a drive loop, a schedule, or CI. No flow
declares an `on()` trigger, none is deployed, and nothing outside `regressions/`
references it except one backlog line in `ops/BACKLOG.md`. They are written
against `@relayflows/surface` — the v2 authoring surface, which does not exist
yet. `regressions/surface.d.ts` is a declaration-only slice of it: the exact
shapes these four pairs need, so the file doubles as a requirements list for
gate-1 SDK work. Delete it when the real surface ships.

## Running them, once the kernel can

```sh
flows check regressions/<slug>.red.flow.ts     # preflight: refuses on a missing gate
flows run   regressions/<slug>.red.flow.ts     # expected: PASS while the bug is open
flows run   regressions/<slug>.green.flow.ts   # expected: FAIL while the bug is open
```

Opt-in typecheck (deliberately *not* part of `cd sdk && npm test`):

```sh
cd sdk && npx tsc -p ../regressions/tsconfig.json
```

`MANIFEST.json` carries the same table in machine-readable form — slug, required
gates, `blockedUntil`, `dependsOn` — so the Garden can pick each pair up
automatically the moment its gates close.

## The suite

| slug | bug | evidence | gates required to run | upstream |
|---|---|---|---|---|
| `enrollment-token-bearer-auth` | Minting an enrollment token gates on `requireSessionAuth`, so a valid CLI bearer gets 403 — worker enrollment has no headless, self-host, or CI path. | `cloud packages/web/app/api/v1/workers/enrollment-tokens/route.ts:113-115`; response `{"error":"Forbidden"}` (403) | gate-1, gate-6, gate-8 | cloud#3202 |
| `worker-daemon-bun-argv` | `cloud worker start --daemon` re-execs the bun-compiled binary with `process.argv[1]`, which is a virtual `$bunfs` path; the child dies at once while the CLI reports success. | `relay packages/cli/src/cli/commands/cloud-worker.ts:266` (`process.argv[1] ?? 'agent-relay'`), `:279` (spawn `process.execPath`), `:396` (success log); `error: unknown command '/$bunfs/root/agent-relay-darwin-arm64'` | gate-1, gate-6, gate-7 | to file — relay CLI |
| `cron-succeeded-into-void` | A fired schedule is marked `lastTriggerStatus: "succeeded"` as soon as the launch POST returns a runId, even with no worker to claim it. A schedule can be silently zero forever. | `cloud packages/web/app/api/v1/workflows/schedules/trigger/route.ts:178-192`; runs `8e3e5916` and `740c3a27` on schedule `flows-drive` — both succeeded, nothing executed, no branch, no PR | gate-1, gate-2, gate-6 | to file — cloud RelayCron |
| `cross-account-workspace-404` | Another account's workspace answers 404 with no code and no user message; the client renders every non-ok response as a permissions problem. | `cloud .../enrollment-tokens/route.ts:29-32` (404 `{"error":"Workspace not found"}`), `cloud packages/web/components/workers/NewWorkerForm.tsx:91-92`; workspaces `50587328-…` (khaliq@agentrelay.com) vs `0fb35c2e-…` (khaliqgant@gmail.com) | gate-1, gate-6, gate-8 | to file — cloud |

Two of these are covenant violations, not merely defects:
`cron-succeeded-into-void` is covenant 2 verbatim — *"a 'succeeded' that did
nothing is by definition a kernel bug"* — and so, in its own way, is
`worker-daemon-bun-argv`: the CLI reports a pid for a process that is already
gone. `cross-account-workspace-404` is covenant 1: the error names the wrong
condition in the user's vocabulary, so the user retries with permissions they
already have.

## What the dialect cannot say yet

Written down here rather than worked around silently, because each one is a real
gap in the surface:

1. **No declared-failure assertion.** A red case must say "this operation fails,
   in this declared way". The surface has `.gate()` — which *causes* a typed
   failure — but no `expect(kind)` which *asserts* one. Every red probe is
   therefore a deterministic step that always exits 0 and prints
   `<body>\n<status>` (see `probe.ts`), letting a postfix gate judge the observed
   response. It works, but the shape it wants is a first-class negative gate.
   This belongs with the gate-1 verification work.
2. **No browser helper**, so "the UI shows this string" is not assertable.
   `cross-account-workspace-404` asserts the API-level cause instead — the body
   carries no `code` the client could branch on — and its green case moves the
   user-facing message to the API, where the condition is actually known.
3. **No macOS placement.** `worker-daemon-bun-argv` only reproduces on the
   darwin-arm64 compiled binary; the sandbox router (gate 7) has no such pool.
   The pair declares `workspace: "sandbox:darwin-arm64"` and waits.
4. **Multi-principal runs are declarative only.** These flows need two or three
   credential principals in one run. They are expressed as
   `mnt/agentworkforce-cloud/principals/<name>/token` mount reads plus an `as:`
   argument on each helper verb — the filesystem path *is* the permission — but
   gate 8 has to make that real and non-ambient before any of it holds.
5. **Durable waiting is a helper, not a verb.** `f.cloud.workers.awaitHeartbeat`
   compiles to a kernel wait, which the plugin contract permits. If waiting
   turns out to be common enough in authored flows, it wants a name of its own.
