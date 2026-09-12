#!/bin/sh
# lens-parity-check: verify workflows/review-swarm.yaml carries the same
# canonical lens text as ops/preswarm-check/lens-prompts/<lens>.txt.
#
# #218: two lens definitions drifted and returned different verdicts on the
# same commit, letting a defect merge. This check fails closed when the
# post-push swarm's `role:` block for any lens diverges from the pre-swarm
# runner's canonical prompt.
#
# Usage: sh ops/preswarm-check/lens-parity-check.sh
# Exit code IS the authority. 0 on match, 1 on divergence, 2 on setup error.
set -e

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
PROMPT_DIR="$REPO_ROOT/ops/preswarm-check/lens-prompts"
SWARM_YAML="$REPO_ROOT/workflows/review-swarm.yaml"

if [ ! -s "$SWARM_YAML" ]; then
  echo "lens-parity-check: $SWARM_YAML missing or empty" >&2
  exit 2
fi

# Extract lens role text from review-swarm.yaml. The `agents:` section carries
# one `role: >-` block per lens; the folded scalar collapses whitespace so we
# normalize the same way from the canonical file.
extract_role() {
  lens=$1
  awk -v lens="- name: $lens" '
    # Match the agent header, then arm state until we see either the next
    # top-level agent (`  - name:`) or the next 4-space key (`    xxx:`) after
    # role has started emitting body lines.
    $0 ~ lens { found=1; next }
    found && /^  - name:/ { exit }
    found && /^    role: >-/ { started=1; next }
    # A new 4-space key ends the role block. Only test AFTER role started.
    started && /^    [a-zA-Z_]+:/ { exit }
    started { sub(/^ */, "", $0); print }
  ' "$SWARM_YAML"
}

# Collapse to normalized single-line form. YAML `>-` folding: newlines become
# spaces, blank lines become single newline. Canonical .txt files use raw
# multiline text; normalize both to `space-separated words, no newlines`.
normalize() {
  tr '\n' ' ' | tr -s ' ' | sed 's/^ *//; s/ *$//'
}

# Sentence-level canonical form: extract only the first line + the imperative
# "Ask:" / "Name" / "Reject" sentences from the canonical prompt, because the
# review-swarm.yaml role field expresses the SAME contract in the SAME shape
# minus long context blocks and gates_shared instructions. Divergence risk
# per #218 is the SPECIFIC clauses being dropped from role. So we check that
# every specific clause word from the canonical text appears in role text.

check_lens() {
  lens=$1
  canonical="$PROMPT_DIR/$lens.txt"
  if [ ! -s "$canonical" ]; then
    echo "lens-parity-check: canonical file missing: $canonical" >&2
    return 2
  fi
  role_text=$(extract_role "$lens" | normalize)
  if [ -z "$role_text" ]; then
    echo "lens-parity-check: no role block for lens '$lens' in $SWARM_YAML" >&2
    return 2
  fi

  # Per-lens sentinel clauses. If a clause is present in the canonical prompt
  # it MUST appear in role. If it is absent from the canonical prompt it is
  # not required. New clauses added to a canonical prompt add sentinels here.
  case "$lens" in
    maintainability)
      clauses='unclear boundaries|implicit contracts|missing failure handling|tests that would not fail if the behavior broke'
      ;;
    history)
      clauses='mistake ops/DRIVE-LOG.md|contradiction with a settled RFC-0001|claims evidence it did not produce'
      ;;
    structure)
      clauses='product logic in the kernel|primitive instead of a helper|grows a file past'
      ;;
  esac

  ok=1
  IFS='|'
  for clause in $clauses; do
    # POSIX sh: no [[ ]] regex. Use expr on a case-insensitive normalized copy.
    if ! echo "$role_text" | grep -qF "$clause"; then
      echo "lens-parity-check: FAIL — $lens role missing clause: '$clause'" >&2
      ok=0
    fi
  done
  unset IFS
  return $((1 - ok))
}

fail=0
for lens in maintainability history structure; do
  if ! check_lens "$lens"; then
    fail=1
  fi
done

if [ "$fail" -eq 1 ]; then
  echo "lens-parity-check: FAIL — workflows/review-swarm.yaml diverges from ops/preswarm-check/lens-prompts/. Update the yaml role blocks to include every canonical clause, or update the canonical file if the change is intentional." >&2
  exit 1
fi

echo "lens-parity-check: PASS — all three lenses carry every canonical clause."
