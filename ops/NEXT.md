# NEXT — work package for this tick

**Gate 3, pinned by ops/TARGET.md**

## Scope (quoted from TARGET.md)

Wire the review-swarm to fire on PR open via GitHub Actions + `agent-relay cloud run`. CODE task, `.github/workflows/`-side.

## Objective

Create a GitHub Actions workflow that automatically triggers the existing `workflows/review-swarm.yaml` on PR open/synchronize/reopen for drive-loop PRs only, fetches the results, and posts them as PR comments.

## Files in scope

- `.github/workflows/review-swarm.yml` (to be created)
- `.github/workflows/scripts/swarm-post.sh` (to be created) — shell script that posts review transcripts as PR comments
- `README.md` OR a file in `docs/` — document the `RELAY_WORKSPACE_KEY` secret requirement

## Definition of done

ALL of the following must hold:

1. **`.github/workflows/review-swarm.yml` exists and is valid YAML**
   - Triggers on `pull_request` events: `opened`, `synchronize`, `reopened`
   - Gates on drive-loop authors only: `github.event.pull_request.user.login` in `kjgbot`, `miyaontherelay`
   - Concurrency group per PR (cancels in-flight review when new push arrives)
   - Steps:
     a. Checkout PR head at merge commit
     b. Install `agent-relay` (curl release or `mise install` — check `.env.example`)
     c. Write PR number to `.review-target`
     d. Invoke `agent-relay cloud run workflows/review-swarm.yaml` with `RELAY_WORKSPACE_KEY` from repo secret
     e. Poll `agent-relay cloud status <runId> --json` every 30s for up to 45 min
     f. `agent-relay cloud sync <runId>` to fetch artifacts
     g. Post each `ops/reviews/*-pr<N>-*.md` as a PR comment via `gh pr comment`
     h. Post aggregate marker: `🎯 review-swarm: PASSED|FAILED (M:<v> H:<v> S:<v>)`
   - YAML validity verified: neither actionlint nor yamllint available in this sandbox, so validation is manual inspection against GitHub Actions schema

2. **Documentation of `RELAY_WORKSPACE_KEY` secret**
   - One sentence in `README.md` or `docs/` stating the required repo secret and what it does
   - Cited verbatim in ops/NEXT.md to prove existence

3. **Author-gating logic is correct**
   - The workflow's `jobs.review.if` expression evaluates:
     - TRUE for `kjgbot`
     - TRUE for `miyaontherelay`
     - FALSE for `khaliqgant` or other human authors
   - Verification: paste the exact if-expression and manually test it (bash or JavaScript equivalent)

4. **Shell posting logic proven to work**
   - `.github/workflows/scripts/swarm-post.sh` exists
   - Takes runId and PR number as arguments
   - Reads `ops/reviews/*-pr<N>-*.md` and posts each via `gh pr comment`
   - Dry-run test output quoted: run the script against an existing completed cloud run and paste the posted comment URL(s) OR the gh output proving it would work

5. **SDK tests are green**
   ```
   cd sdk && npm test
   ```
   SDK currently fails due to missing node_modules — `npm ci` must succeed first in the sandbox. Literal test output pasted in final summary.

6. **Every new test fails against current code first**
   - If any test is added, show it FAILING before the implementation exists
   - Quote the literal failing output

7. **Final git status**
   - As the LAST action before ASSESS_DONE, run:
     ```
     git status --porcelain
     ```
   - Paste the output verbatim

## Explicitly OUT OF SCOPE

- **Fixing `RELAY_WORKSPACE_KEY` if missing** — this is a human prerequisite. If `gh secret list --repo AgentWorkforce/flows` shows the secret is absent, write ops/NEEDS_HUMAN.md stating the exact issue and end with ASSESS_DONE. The secret must be added manually in repo settings (workspace key is at `~/.agentworkforce/relay/cloud-auth.json` on the laptop).
- **Auth troubleshooting** — if `agent-relay cloud run` fails with an auth error from GHA, DO NOT invent workarounds. File ops/NEEDS_HUMAN.md and end with ASSESS_DONE.
- **Modifying the SDK worker** — `sdk/src/worker.ts` is shipped (PR #53, `9681f11`). Do not touch it. TARGET.md explicitly forbids this.
- **Touching preflight validation** — PR #47, #50 closed. Do not modify `sdk/src/work-package-validator.ts` or preflight code.
- **Modifying gate-1 regression tests** — `kernel/relayflowd/src/server/tests.rs` and `server.rs` are off-limits per TARGET.md.
- **Redoing closed PRs** — picker actionability (#42), unterminated backticks (#45), deterministic-command preflight (#47), gate-1 race test (#48), ops/NEXT.md validation (#50).

## Blocked prerequisites to surface, not fix

From TARGET.md:
- `RELAY_WORKSPACE_KEY` secret must exist in GitHub Actions
- `agent-relay cloud run` must reach the same workspace as the laptop

If either is missing, write ops/NEEDS_HUMAN.md naming the exact blocker and what is needed, then end with ASSESS_DONE. A partial deliverable (a working workflow YAML that stalls at auth) plus a NEEDS_HUMAN is a complete result.

## Notes

- This is gate 3. Gate 1 is GREEN (asterisk closed, PR #48). Gate 2 is AMBER (proactive agent primitives landed, pending Khaliq's read on whether manual poller satisfies "runs as a relayflow").
- `workflows/review-swarm.yaml` already exists and has run manually — this ticket is the automation layer only.
- No `.git` or `gh` auth in this cloud sandbox (ops/STATE.md known fault #1) — cannot test `gh pr comment` or `gh secret list` directly. Shell script logic should be inspectable and a dry-run against a hypothetical runId can be shown.
- Exec bit not preserved in sandboxes (ops/STATE.md known fault #2) — invoke scripts via `sh` if needed.
