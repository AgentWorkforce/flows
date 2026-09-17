# Event-await overnight flows

`implement-event-await.flow.ts` is a local, journaled implementation loop for
the merged `docs/EVENT-AWAIT.md` contract. It uses direct local Codex workers
in one isolated worktree. It may create local commits and evidence only; it
does not push, open a pull request, merge, deploy, publish, or touch Cloud
credentials.

Run it from this directory after installing dependencies:

```sh
flows check implement-event-await.flow.ts
flows run implement-event-await.flow.ts --local-agent --input '{
  "repoRoot": "/Volumes/Paris Drive/AgentWorkforce/.worktrees/flows-v2-lead-0913/event-await-flows-overnight-0917",
  "auditPasses": 2
}'
```
