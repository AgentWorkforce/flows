# regressions — executable bug reports, red then green

Five platform bugs were found on 2026-08-27, during the first dogfood runs. Each
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
shapes these pairs need, so the file doubles as a requirements list for
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
| `relaycast-workspace-key-repair-500` | Relaycast's internal workspace-key repair route does its D1 write with no `try`/`catch`, so a `workspaces_api_key_hash_unique` violation escapes the worker as a bare non-JSON 500 — and every cloud workflow launch for the workspace dies with an HTTP status line instead of a named condition. | `relaycast-cloud packages/relaycast/src/fleet/routes.ts:550-566` (unguarded `UPDATE`/`INSERT`), `:587-594` (dispatch), `packages/relaycast/src/entrypoints/cloudflare.ts:182-183` (no wrap); caller `cloud packages/web/lib/workflows/relay-workspace.ts:222-243`, message at `:238-241`; jobs `9a26d44d` (manual, failed), `0c96a292` + `09e842f0` (cron, launching) — all `Relaycast workspace key repair failed: 500 Internal Server Error`; app ws `50587328-…` → relay ws `rw_7ccfea89` | gate-1, gate-6, gate-8 | to file — relaycast-cloud |

### `relaycast-workspace-key-repair-500` is not reproducing

Re-checked 2026-08-27 18:46-18:52Z: four launches fired with a `wrangler tail`
attached, and all four repair calls answered **200 with zero exceptions**; one
run reached `running` with a sandbox. `rw_7ccfea89`'s stored `api_key_hash` was
unchanged across the whole window, so each push was a self-update — which can
never violate `workspaces_api_key_hash_unique`. The original 500s therefore look
more like a transient fault than a constraint collision, though a key change
between 18:24Z and 18:46Z cannot be excluded from here.

The defect is unchanged: the route still runs its D1 statements with no
`try`/`catch`, so any database fault — permanent or transient — still reaches
the operator as a bare, untyped `500 Internal Server Error`. A transient fault
is the worse case, because the caller cannot tell it apart from a permanent one
and retries forever.

This makes the pair the suite's first **false-green** hazard: the green case
passes against healthy production while the defective code is still deployed.
Until a flow can inject a dependency fault, judge this pair by reading
`routes.ts`, not by its exit code.

Three of these are covenant violations, not merely defects:
`cron-succeeded-into-void` is covenant 2 verbatim — *"a 'succeeded' that did
nothing is by definition a kernel bug"* — and so, in its own way, is
`worker-daemon-bun-argv`: the CLI reports a pid for a process that is already
gone. `cross-account-workspace-404` is covenant 1: the error names the wrong
condition in the user's vocabulary, so the user retries with permissions they
already have. `relaycast-workspace-key-repair-500` is covenant 1 in its harshest
form — the response names *no* condition at all. The failure is permanent and
fully knowable at the point it is raised (the route holds the workspace id, the
key, and the constraint that rejected it), yet the operator is handed
`500 Internal Server Error` and retries a launch that can never succeed.

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
5. **No service-principal mount.** The relaycast gateway's internal API is
   guarded by a shared service bearer rather than a user session, but it still
   has to resolve from `<mount>/principals/<name>/token` like every other
   credential, and the workspace key it re-registers has to be read inline from
   the cloud mount so no secret reaches the flow source or the journal.
   `relaycast-workspace-key-repair-500` declares both and waits on gates 6 and 8.

6. **Durable waiting is a helper, not a verb.** `f.cloud.workers.awaitHeartbeat`
   compiles to a kernel wait, which the plugin contract permits. If waiting
   turns out to be common enough in authored flows, it wants a name of its own.
