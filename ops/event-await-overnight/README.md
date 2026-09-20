# Event-await overnight flows

`implement-event-await.flow.ts` is a local, journaled implementation loop for
the proposed `docs/EVENT-AWAIT.md` contract. It uses direct local Codex workers
in one isolated worktree. It may create local commits and evidence only; it
does not push, open a pull request, merge, deploy, publish, or touch Cloud
credentials.

Run it from this directory after installing dependencies:

```sh
flows check implement-event-await.flow.ts
flows run implement-event-await.flow.ts --local-agent --input '{
  "repoRoot": "/absolute/path/to/an/isolated/flows/worktree",
  "auditPasses": 2
}'
```

This is the historical implementation driver, not the acceptance flow for this
PR. Its pinned SDK dependencies describe that driver’s execution environment.
Use the current CLI probe documented in `docs/EVENT-AWAIT.md` to verify the
local event-wait path.
