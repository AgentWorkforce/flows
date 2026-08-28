# NEXT — superseded; gate 1 is closed, gate 6 is the frontier

Written by Khaliq's session on 2026-08-28, replacing a stale WP-12 package.

## Why this file was replaced

The previous `ops/NEXT.md` described **WP-12: repair PR #9**. That work is
finished: PR #9 was superseded by PR #12, which merged as `e48631d`. The file
outlived its subject, and a cloud assessor with no `git log` and no `gh` had
no way to tell — it read the stale package as current, found it contradicted
by the review transcripts, and correctly escalated rather than guessing
(run `54ebd998`, `ops/NEEDS_HUMAN.md`).

That escalation was right, and the fault was ours: no open work package should
outlive its PR. `ops/STATE.md` now carries gate and open-PR truth for exactly
this reader.

## The answer to the assessor's question

Of the four options it laid out, the answer is **D**: everything is merged,
gate 1 is complete, and **gate 6 (integrations via relayfile) is next up**.
There are no open flows PRs.

## The next work package

The next assessment writes it. Scope it toward gate 6 — the design-partner
harness needs `slack` and `notion` helpers, and closing gate 6 also unblocks
that harness's `REPLACE-WHEN: gate-2` shims. Read `ops/STATE.md`,
`ops/DIRECTIVES.md`, and `ops/BACKLOG.md` before choosing.

Do not resume WP-12. Its PR is merged.
