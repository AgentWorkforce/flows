# NEXT — work package for this tick

## Scope

**TARGET: Gate 3** — Wire the review-swarm to fire on PR open via GitHub Actions + agent-relay cloud run. CODE task, .github/workflows/-side.

This run is pinned to gate 3 and must not work on any other gate. The review swarm workflow (workflows/review-swarm.yaml) already exists in this repo with three model-diverse reviewers (claude/codex/opencode) that read a PR diff and produce independent transcripts plus an aggregate verdict. Today it only fires when a human writes .review-target and runs agent-relay cloud run by hand. It has run zero times against a drive PR on cloud.

## Objective

Add .github/workflows/review-swarm.yml that automatically fires the review swarm on PR open/synchronize for drive-loop PRs only (kjgbot, miyaontherelay). That is the only file this tick should create.

## Files in scope

- .github/workflows/review-swarm.yml (NEW)
- .github/workflows/scripts/swarm-post.sh (NEW, optional companion script)
- README.md or docs/ (one-sentence note about RELAY_WORKSPACE_KEY secret)

## Definition of done

All of the following must hold:

1. .github/workflows/review-swarm.yml exists and passes actionlint (if installed) or yamllint

2. The workflow correctly gates on drive-loop authors only:
   - trigger: pull_request events opened, synchronize, reopened
   - jobs.review.if expression evaluates true for kjgbot and false for khaliqgant (test by hand)
   - concurrency group per PR so a second push cancels the first review

3. The workflow's job steps implement:
   - checkout the PR's head at merge commit
   - install agent-relay (check .mise.toml and .env.example for how this repo does it)
   - echo "$PR_NUMBER" > .review-target
   - agent-relay cloud run workflows/review-swarm.yaml with RELAY_WORKSPACE_KEY from repo secret; capture runId
   - poll agent-relay cloud status <runId> --json every 30s until status == completed or 45 min
   - agent-relay cloud sync <runId> to fetch artifacts
   - read ops/reviews/*-pr<N>-*.md produced by swarm; post each as PR comment via gh pr comment
   - post aggregate marker by grepping for SWARM_PASSED or SWARM_FAILED

4. README.md or docs/ describes the required repo secret RELAY_WORKSPACE_KEY (one sentence)

5. A dry-run test proves the shell logic works:
   - Demonstrate posting script against an EXISTING completed cloud run
   - Quote the posted comment URL in the assessment

6. SDK tests remain green (197 passed)

7. Kernel tests remain green (77 passed)

8. Final git status (paste literal output)

## Explicitly OUT of scope

- Do NOT attempt to fix missing prerequisites
- Do NOT run the workflow against a real PR (only dry-run)
- Do NOT touch any gate other than gate 3
- Do NOT touch merged items: #42, #45, #47, #48, #50, #53

## Prerequisites this brief cannot satisfy

BLOCKED — surface, don't try to fix:

1. RELAY_WORKSPACE_KEY must exist as a GitHub Actions secret. Check with gh secret list. If missing, write ops/NEEDS_HUMAN.md and STILL end with ASSESS_DONE.

2. No .github/ directory exists in this sandbox (snapshot sync, no git history per ops/STATE.md). Creating it may fail verification.

3. agent-relay cloud run from GHA must reach the same cloud workspace. If auth fails, file NEEDS_HUMAN and stop.

## If blocked

Write ops/NEEDS_HUMAN.md with the exact question and options, and STILL end with ASSESS_DONE. A working workflow stalled at auth plus NEEDS_HUMAN is a complete deliverable.

Do not silently substitute different work.
