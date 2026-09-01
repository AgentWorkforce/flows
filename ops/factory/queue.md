# Factory queue — parseable task queue for `ops/factory/driver.sh`

Human-authored list of concrete, ships-in-one-PR tasks the factory
picks from. Each line is one task. Format:

    - [ ] TASK_ID: <one-line summary>. Brief: <path to a brief file or
          inline description>
    - [~] [CLAIMED by <worker-id> at <ISO-UTC>] TASK_ID: <summary>
    - [x] [DONE via #<PR>] TASK_ID: <summary>
    - [!] [FAILED at <ISO-UTC>: <reason>] TASK_ID: <summary>

Rules:
- `TASK_ID` is a short slug the driver stamps into the branch name
  (`factory/<TASK_ID>`) and into the working directory it creates.
- One line per task. Multi-line briefs live in `ops/factory/briefs/<TASK_ID>.md`.
- **No `]` characters in the summary** — the driver's state-cycle
  rewrite uses `sed 's/^- \[~\][^]]*\] //'` which stops at the
  first `]`. A summary containing `]` would corrupt the queue on
  transition. Keep summaries plain-prose. This is a known limit
  of the markdown-as-queue shim; see `ops/factory/README.md`
  §"Scope and RFC-0001 posture" for the migration plan.
- The driver claims by rewriting `- [ ]` to `- [~]`; on success it
  rewrites to `- [x]`; on failure `- [!]`. The driver is
  single-instance (guarded by `factory-driver.lock`) and does its
  claim rewrites sequentially — no queue-file lock ships; the
  DRIVER_LOCK and the inherently sequential outer loop are the
  only serialization mechanism. Workers never touch this file.
- **The driver never re-picks `- [!]` tasks** — a human triages
  those (bump to `- [ ]` again, or delete/rework).
- **Tasks whose PR touches any judge — `ops/factory/**`,
  `ops/preswarm-check/**`, or `workflows/preswarm-check.yaml` —
  are refused by the driver** at the diff-check step AFTER the
  worker returns `STATUS=opened`. This is fail-closed against a
  rogue agent — the brief-text rule is advisory; the diff check
  is enforcement. All three paths are gates the factory judges
  itself by (self-mod, lens-runner, workflow), so editing them
  from inside the factory violates RFC-0001 settled decision #6
  ("no gate editable by the agents it judges"). The refuse-list
  is enforced on the diff even if a brief slips through — the
  check runs against the diff produced, not the brief text.
- **Nothing merges without swarm PASS** — the driver just gets the
  PR opened; `com.agentworkforce.auto-merge` on the launchd loop
  is the merge authority.

## Queue

- [ ] hn-monitor-real-cli: Wire hn-monitor's analyze-story step to invoke a real LLM (claude -p) that reads $RELAYFLOW_WAKE_CONTEXT and returns json_schema-shaped analysis. See ops/factory/briefs/hn-monitor-real-cli.md.

<!--
DELIBERATELY NOT QUEUED — tasks whose implementation touches
ops/preswarm-check/** or ops/review-swarm-loop.sh cannot be
authored by the factory (RFC-0001 settled decision #6: the
agent cannot edit the gate that judges it). Two known such
tasks are captured in the human backlog rather than as
factory-brief files (both have been deleted from
ops/factory/briefs/ since keeping them there was misleading —
they were structurally undispatchable):

  - rulebook-consolidation — extract lens prompts into ONE
    source file both the local preswarm check and the post-push
    swarm read from. HUMAN task.

  - preswarm-classifier-test — shell-harness unit test for
    ops/preswarm-check/lens-runner.sh's classifier. HUMAN task.

If a similar task is added later, the driver's diff check will
refuse it. Add it as a HUMAN task, not a factory brief.
-->
