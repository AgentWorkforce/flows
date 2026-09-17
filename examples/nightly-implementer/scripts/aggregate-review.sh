#!/usr/bin/env bash
# aggregate-review.sh — deterministic verdict combiner.
#
# Reads the three lens verdicts and the verify gate result from FLOWS_INPUT
# (the JSON env the runner sets from a step's declared `input:` bindings).
# Emits {approved: bool, blockers: string[]} on stdout.
#
# Approved requires ALL FOUR of:
#   correctness.blocked  === false
#   regression.blocked   === false
#   maintainability.blocked === false
#   verify.numFailed     === 0
#
# A missing field, an unexpected shape, or ANY blocked=true from a lens
# fails the aggregate. The script is deliberately dumb — no LLM interpretation,
# no partial credit. This is the mechanical clearance the drive-local class
# fix (flows#284) needs so no accumulated reviewer bias can approve broken code.
set -euo pipefail

input="${FLOWS_INPUT:-}"
[ -n "$input" ] || input='{}'

blockers=$(jq -c '
  def lens($name; $obj):
    if ($obj.blocked != false) then
      if (($obj.reasons // []) | type != "array" or length == 0) then
        ["[\($name)] blocked with no reasons — treat as blocked"]
      else
        $obj.reasons | map("[\($name)] \(.)")
      end
    else [] end;
  ( lens("correctness"; .correctness)
  + lens("regression"; .regression)
  + lens("maintainability"; .maintainability)
  + (if (.verify.numFailed // 1) > 0 then
       ["[verify] \((.verify.numFailed // 0)) test(s) failing"]
     else [] end)
  )
' <<<"$input")

count=$(jq 'length' <<<"$blockers")

if [ "$count" = 0 ]; then
  jq -n '{approved: true, blockers: []}'
else
  jq -n --argjson blockers "$blockers" '{approved: false, blockers: $blockers}'
fi
