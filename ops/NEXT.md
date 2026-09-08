# NEXT — gate 3: complete cloud review-swarm preflight validation and documentation

**Scope:** Track D: Cloud review-swarm redesign — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

## Why this matters

The local `~/AgentWorkforce/review-swarm-loop.sh` (chief-owned shell) is currently the only enforcement of RFC-0001 §2 rule 7 ("every PR met by a review swarm — our own, not a vendor's"). It works, but it lives on my laptop. When my session ends, so does swarm enforcement.

The cloud version — `workflows/review-swarm.yaml` fired from `.github/workflows/review-swarm.yml` — must exist for gate 3+ work to be trustworthy. Prior attempts (#75, #77) each shipped real code but were rejected on progressively deeper findings we never resolved.

## Current state

The review-swarm implementation is 90% complete. Analysis of the 9 non-negotiable requirements:

1. ✅ Immutable gate — two checkout steps at `.github/workflows/review-swarm.yml:32-48` (pr-head + gate-files from main)
2. ✅ Unified verdict logic — `swarm-verdict.sh` sourced by both `review-swarm.yaml:132` and `swarm-post.sh:8`
3. ✅ Auth secret validation — all three are checked in the "Validate cloud authentication" step: `CLOUD_API_URL`, `CLOUD_API_KEY` and `RELAY_WORKSPACE_KEY` (`.github/workflows/review-swarm.yml:56-58`)
4. ✅ Sticky marker + transcripts — HTML anchors `<!-- swarm-lens: {lens} -->` in swarm-post.sh:34,39,44,47
5. ✅ No author whitelist — grep confirms absent
6. ✅ Cloud sandbox fetch on GHA runner — swarm-prepare.sh runs in step "Prepare review input" with GH_TOKEN
7. ✅ Timeout ordering — 60m (review-swarm.yaml:18) < 65m (review-swarm.yml:112) < 75m (review-swarm.yml:19) with comments
8. ✅ Wait step records status, post runs on always() — review-swarm.yml:106-130,132-137
9. ✅ Transcript-to-run-id binding via freshness — swarm-prepare.sh:11 creates run-start marker; swarm-verdict.sh:33-34 rejects stale transcripts

Additionally: README.md's secrets table is already correct — it documents
`RELAY_WORKSPACE_KEY` and `CLOUD_API_KEY`, and names neither
`CLOUD_API_ACCESS_TOKEN` nor `CLOUD_API_REFRESH_TOKEN`. The one residual is the
sentence after the table, which still tells admins they may override
`CLOUD_API_ACCESS_TOKEN_EXPIRES_AT`; the workflow no longer reads that variable
at all, so the override has no effect.

## Files in scope

- `README.md` — drop `CLOUD_API_ACCESS_TOKEN_EXPIRES_AT` from the non-secret
  sentence under the secrets table; it names a variable nothing reads.

Nothing else. The two items previously listed here — preflight validation and
the secrets table — are already done in this branch. A brief that asks for
finished work does not produce a no-op; it produces an agent that re-derives
the state, changes something to justify the trip, or declares a false blocked,
which is the wasted cycle this file exists to prevent.

## Definition of done

1. ✅ Already satisfied — preflight checks all three required secrets:
```
test -n "$CLOUD_API_URL"
test -n "$CLOUD_API_KEY"
test -n "$RELAY_WORKSPACE_KEY"
```

2. ✅ Already satisfied — README's § "Cloud review swarm" secrets table names
   `RELAY_WORKSPACE_KEY` and `CLOUD_API_KEY`. What remains is only to remove the
   stale `CLOUD_API_ACCESS_TOKEN_EXPIRES_AT` mention below it:
```
grep -c CLOUD_API_ACCESS_TOKEN_EXPIRES_AT README.md   # must be 0
```

3. All files continue to parse:
```
bash -n .github/workflows/scripts/swarm-post.sh && \
bash -n .github/workflows/scripts/swarm-prepare.sh && \
bash -n .github/workflows/scripts/swarm-verdict.sh && \
echo "All bash scripts parse OK"
```

```
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))" && \
python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))" && \
echo "YAML files parse OK"
```

4. No author whitelist exists:
```
grep -i "whitelist\|github.event.pull_request.user.login" .github/workflows/review-swarm.yml || echo "No author whitelist found (GOOD)"
```

5. As final action:
```
git status --porcelain
```

## Explicitly OUT of scope

- `workflows/review-swarm.yaml` (already correct)
- `.github/workflows/scripts/swarm-*.sh` (all three scripts already correct)
- `.gitignore` (already correct - no .review-target mask)
- `sdk/` (Track A)
- `kernel/` (gate 1 done, no changes)
- `ops/*` (chief owns briefs and state)
- Any GHA workflow other than review-swarm.yml
- Actually TESTING the workflow in CI (requires `RELAY_WORKSPACE_KEY` + `CLOUD_API_KEY` secrets set which is a human step per requirement #3's context)
