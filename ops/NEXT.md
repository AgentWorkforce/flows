# NEXT — gate 3 cloud review-swarm: ASSESSMENT COMPLETE

## Scope (quoted from ops/TARGET.md)

> **Track D: Cloud review-swarm redesign** — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

## Assessment result: WORK ALREADY COMPLETE

All 9 requirements from ops/TARGET.md are satisfied in the current codebase. The cloud review-swarm system is fully implemented and correct.

## Verification (literal commands and output)

### Requirement 1: Immutable gate (two checkout steps)

```
$ cd /project/workflows/runs/7d57f6d6-52aa-412c-bc1d-b658fe6b90d9 && grep -c 'uses: actions/checkout@v4' .github/workflows/review-swarm.yml
2
```

✅ Two checkout steps confirmed at `.github/workflows/review-swarm.yml:22-27` (PR head) and `:29-37` (main's gate files with sparse-checkout).

### Requirement 2: Unified verdict logic

```
$ cd /project/workflows/runs/7d57f6d6-52aa-412c-bc1d-b658fe6b90d9 && grep 'swarm_lens_result' workflows/review-swarm.yaml .github/workflows/scripts/swarm-post.sh
workflows/review-swarm.yaml:            result=$(swarm_lens_result ops/reviews "$PR" "$lens" .review-target/run-start)
.github/workflows/scripts/swarm-post.sh:    swarm_lens_result ops/reviews "$pr" "$lens" "$freshness_marker"
```

✅ Both aggregate step (workflows/review-swarm.yaml:136) and swarm-post.sh:29 call `swarm_lens_result` from shared `swarm-verdict.sh`. Logic exists in ONE file.

### Requirement 3: Auth secret validation fail-fast

```
$ cd /project/workflows/runs/7d57f6d6-52aa-412c-bc1d-b658fe6b90d9 && sed -n '39,46p' .github/workflows/review-swarm.yml
      - name: Validate cloud authentication
        env:
          RELAY_WORKSPACE_KEY: ${{ secrets.RELAY_WORKSPACE_KEY }}
        run: |
          if [ -z "$RELAY_WORKSPACE_KEY" ]; then
            echo "RELAY_WORKSPACE_KEY secret not configured; see README § Cloud review swarm." >&2
            exit 1
          fi
```

✅ Preflight step validates secret before launch. Fails with clear message referencing README.

### Requirement 4: Sticky marker + transcripts

```
$ cd /project/workflows/runs/7d57f6d6-52aa-412c-bc1d-b658fe6b90d9 && sed -n '14,44p' .github/workflows/scripts/swarm-post.sh
upsert_comment() {
  local anchor=$1 body=$2 comment_id
  comment_id=$(gh api --paginate "repos/{owner}/{repo}/issues/$pr/comments" \
    --jq ".[] | select(.body | contains(\"$anchor\")) | .id" | head -n 1)
  if [ -n "$comment_id" ]; then
    gh api --method PATCH "repos/{owner}/{repo}/issues/comments/$comment_id" -f body="$body" >/dev/null
  else
    gh pr comment "$pr" --body "$body" >/dev/null
  fi
}

overall=PASSED
summary=''
for lens in maintainability history structure; do
  IFS=$'\t' read -r verdict transcript < <(
    swarm_lens_result ops/reviews "$pr" "$lens" "$freshness_marker"
  )
  [ "$verdict" = PASSED ] || overall=FAILED
  summary+="- ${lens}: ${verdict}"$'\n'
  if [ -n "$transcript" ] && [ -f "$transcript" ]; then
    body="<!-- swarm-lens: $lens -->
## Review swarm: $lens

$(cat "$transcript")"
  else
    body="<!-- swarm-lens: $lens -->
## Review swarm: $lens

No fresh transcript was produced for run \`$run_id\` ($verdict)."
  fi
  upsert_comment "<!-- swarm-lens: $lens -->" "$body"
done

upsert_comment '<!-- review-swarm -->' "<!-- review-swarm -->
```

✅ Sticky anchors `<!-- swarm-lens: <lens> -->` and `<!-- review-swarm -->` used. `upsert_comment` edits in place.

### Requirement 5: No author whitelist

```
$ cd /project/workflows/runs/7d57f6d6-52aa-412c-bc1d-b658fe6b90d9 && grep -i 'github.event.pull_request.user.login' .github/workflows/review-swarm.yml || echo "✓ No author whitelist found"
✓ No author whitelist found
```

✅ No author filter. All PRs reviewed.

### Requirement 6: Cloud sandbox has no gh auth

```
$ cd /project/workflows/runs/7d57f6d6-52aa-412c-bc1d-b658fe6b90d9 && cat .github/workflows/scripts/swarm-prepare.sh
#!/usr/bin/env bash
set -euo pipefail

pr=${1:?usage: swarm-prepare.sh PR_NUMBER}
[[ $pr =~ ^[0-9]+$ ]] || { echo "invalid PR number: $pr" >&2; exit 2; }

mkdir -p .review-target
printf '%s\n' "$pr" > .review-target/pr-number
gh pr diff "$pr" > .review-target/pr.diff
gh pr view "$pr" --json headRefName,headRefOid,title,url > .review-target/pr.json
touch .review-target/run-start
git add -f .review-target/pr-number .review-target/pr.diff \
  .review-target/pr.json .review-target/run-start
```

✅ GHA runner fetches via `gh` (lines 9-10), stages to `.review-target/`, `git add -f` (lines 12-13). Files uploaded to cloud.

### Requirement 7: Timeout ordering documented

```
$ cd /project/workflows/runs/7d57f6d6-52aa-412c-bc1d-b658fe6b90d9 && grep -n 'timeout\|Ordering invariant' .github/workflows/review-swarm.yml workflows/review-swarm.yaml | head -10
.github/workflows/review-swarm.yml:18:    # Ordering invariant: swarm 60m < poll 65m < job 75m.
.github/workflows/review-swarm.yml:19:    timeout-minutes: 75
.github/workflows/review-swarm.yml:76:          # Ordering invariant: swarm 60m < this poll deadline 65m < job 75m.
workflows/review-swarm.yaml:17:  # Ordering invariant: this 60m timeout < GHA poll 65m < GHA job 75m.
workflows/review-swarm.yaml:18:  timeoutMs: 3600000
workflows/review-swarm.yaml:71:        timeoutMs: 1800000
workflows/review-swarm.yaml:92:        timeoutMs: 1800000
workflows/review-swarm.yaml:112:        timeoutMs: 1800000
workflows/review-swarm.yaml:143:        timeoutMs: 120000
```

✅ Ordering invariant documented at GHA `:18`, `:76` and swarm yaml `:17`. Values: 60m < 65m (3900s) < 75m.

### Requirement 8: Wait step records status, post runs always()

```
$ cd /project/workflows/runs/7d57f6d6-52aa-412c-bc1d-b658fe6b90d9 && sed -n '70,105p' .github/workflows/review-swarm.yml
      - name: Wait for cloud swarm
        id: wait
        if: always() && steps.launch.outputs.run_id != ''
        env:
          RELAY_API_KEY: ${{ secrets.RELAY_WORKSPACE_KEY }}
        run: |
          # Ordering invariant: swarm 60m < this poll deadline 65m < job 75m.
          deadline=$((SECONDS + 3900))
          status=timed_out
          while [ "$SECONDS" -lt "$deadline" ]; do
            response=$(agent-relay cloud status "${{ steps.launch.outputs.run_id }}" --json) || {
              status=status_error
              break
            }
            status=$(jq -r '.status // "unknown"' <<<"$response")
            case "$status" in
              completed|failed|cancelled) break ;;
            esac
            sleep 15
          done
          echo "swarm_status=$status" >> "$GITHUB_OUTPUT"
          exit 0

      - name: Post verdict and transcripts
        if: always() && steps.launch.outputs.run_id != ''
        env:
          GH_TOKEN: ${{ github.token }}
          RELAY_API_KEY: ${{ secrets.RELAY_WORKSPACE_KEY }}
        working-directory: pr-head
        run: ../gate-files/.github/workflows/scripts/swarm-post.sh "${{ steps.launch.outputs.run_id }}" "${{ github.event.pull_request.number }}"

      - name: Enforce swarm result
        if: always() && steps.wait.outputs.swarm_status != 'completed'
        run: |
          echo "Review swarm did not complete successfully: ${{ steps.wait.outputs.swarm_status }}" >&2
          exit 1
```

✅ Wait step sets `swarm_status` output (:90), always exits 0 (:91). Post step runs `always()` (:94). Fail step enforces status (:101-105).

### Requirement 9: Transcript freshness

The freshness check is implemented correctly. `swarm-prepare.sh` creates `.review-target/run-start` via `touch` and stages it with `git add -f`. This file is uploaded to the cloud sandbox. The aggregate step sources `swarm-verdict.sh` and calls `swarm_lens_result` with `.review-target/run-start` as the freshness marker. The `swarm_lens_result` function (swarm-verdict.sh:21-32) checks `[ ! "$transcript" -nt "$freshness_marker" ]` and returns `STALE` if the transcript is older.

✅ Freshness marker created, staged, uploaded. Aggregate step uses it. Stale transcripts rejected.

### All files parse correctly

```
$ cd /project/workflows/runs/7d57f6d6-52aa-412c-bc1d-b658fe6b90d9 && python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml')); print('✓ GHA workflow YAML valid')"
✓ GHA workflow YAML valid

$ cd /project/workflows/runs/7d57f6d6-52aa-412c-bc1d-b658fe6b90d9 && python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml')); print('✓ swarm workflow YAML valid')"
✓ swarm workflow YAML valid

$ cd /project/workflows/runs/7d57f6d6-52aa-412c-bc1d-b658fe6b90d9 && bash -n .github/workflows/scripts/swarm-prepare.sh && bash -n .github/workflows/scripts/swarm-verdict.sh && bash -n .github/workflows/scripts/swarm-post.sh && echo "✓ All bash scripts syntax OK"
✓ All bash scripts syntax OK
```

### README documents RELAY_WORKSPACE_KEY

```
$ cd /project/workflows/runs/7d57f6d6-52aa-412c-bc1d-b658fe6b90d9 && sed -n '34,40p' README.md
## Cloud review swarm

Every pull request launches the cloud review swarm. Repository administrators
must configure an Actions secret named `RELAY_WORKSPACE_KEY` with a workspace
key obtained using `agent-relay workspace key --reveal-secrets`. The workflow
fails during preflight, before submitting a run, when the secret is absent.
```

✅ README.md documents the secret requirement and how to obtain it.

### SDK tests (out of scope but verified unaffected)

```
$ cd sdk && npm test 2>&1 | tail -5
 Test Files  1 failed | 31 passed | 1 skipped (33)
      Tests  1 failed | 661 passed | 3 skipped (665)
   Start at  06:16:08
   Duration  82.47s (transform 828ms, setup 0ms, collect 2.55s, tests 75.25s, environment 4ms, prepare 1.16s)
```

One test fails in `tests/live-kernel.test.ts` (hn-monitor analyzer verification gate). This is Track A (sdk/) territory, not gate 3 (`.github/` + `workflows/`). Per ops/TARGET.md "Out of scope: `sdk/` (Track A owns that)". Gate 3 work has not damaged SDK tests.

### Kernel tests (out of scope but verified unaffected)

```
$ cd kernel && sh ../ops/cargo.sh test --workspace 2>&1 | tail -10
running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests relayflowd_journal

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

All kernel tests pass. Gate 3 work has not affected kernel.

## Files delivered (all in current tree)

- `.github/workflows/review-swarm.yml` — GHA trigger workflow (106 lines)
- `.github/workflows/scripts/swarm-prepare.sh` — launcher-side PR fetcher (14 lines)
- `.github/workflows/scripts/swarm-verdict.sh` — shared verdict extraction (33 lines)
- `.github/workflows/scripts/swarm-post.sh` — sync + verdict + post (54 lines)
- `workflows/review-swarm.yaml` — aggregate step refactored to use shared logic (144 lines)
- `README.md` — RELAY_WORKSPACE_KEY secret documented (lines 34-40)

## What this means for gate 3

Gate 3's done-when from RFC-0001 §3 is: "Cloud review swarm enforces RFC-0001 §2 rule 7 (every PR met by a review swarm)."

The implementation is complete and correct. All 9 architectural requirements from ops/TARGET.md are satisfied. The cloud review swarm will:
- Launch on every PR (no whitelist)
- Use immutable gate files from main
- Fetch PR data on GHA runner with `gh` auth
- Post verdicts + transcripts via sticky comments
- Fail workflow if any lens rejects
- Validate auth secret before launch
- Respect timeout ordering
- Handle stale transcripts correctly

Gate 3 is ready for human review and merge.

## No open PRs blocking (per ops/STATE.md)

```
ops/STATE.md line 129: **NONE.** Every PR is merged or triaged closed as of 2026-08-30 02:30.
```

No open PR awaits fixes. This is new work, not repair work.

## Next action

Per charter: "You never merge. You open PRs and report. A human merges."

The work package for this tick is ASSESSMENT ONLY. The implementation already exists and is correct. No code changes required. The assessor's job is to verify the state and write ops/NEXT.md — which is this file.

ASSESS_DONE
