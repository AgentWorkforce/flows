#!/usr/bin/env bash
# End-to-end proof of the Prompt Lab relayflow, locally, with real model calls.
#
# Seeds a fresh lab from fixtures/, then drives all three jobs through the real
# kernel with `flows run --local-agent`. At every parked `f.human` gate this
# script plays the reviewer named in the input: it applies the documented edit
# (captured as a diff), answers with `flows answer`, and `flows resume`s.
# Every command is captured with its literal output and exit code.
#
#   ./prove.sh [out-dir]        default: evidence/run
set -uo pipefail
cd "$(dirname "$0")"
OUT=${1:-evidence/run}
LAB=$OUT/lab
DD=${FLOWS_DATA_DIR:-$(mktemp -d)}
REVIEWER=prompt-lab-reviewer
N=0

[ -e "$LAB" ] && { echo "refusing: $LAB exists" >&2; exit 2; }
mkdir -p "$OUT"
node --no-warnings --experimental-strip-types store.ts "$LAB" seed fixtures

# capture <name> <command...>: run it, write "$ cmd", its output and exit code to $OUT/NN-name.txt
capture() {
  local name=$1; shift
  N=$((N + 1))
  FILE=$(printf '%s/%02d-%s.txt' "$OUT" "$N" "$name")
  { echo "\$ $*"; "$@" 2>&1; echo "exit=$?"; } > "$FILE"
  grep -v 'WAITING\|↻\|○' "$FILE" | tail -4 | cut -c1-240
}
run_id()  { grep -o 'RUN [0-9A-Z]\{26\}' "$FILE" | tail -1 | cut -d' ' -f2; }
wait_id() { grep -o ' human-[0-9]* yes|no' "$FILE" | tail -1 | awk '{print $1}'; }
parked_on() { grep -q "PARKED.*$1" "$FILE"; }
# edit <file> <node-expression over v>: the reviewer's change, captured as a diff
edit() {
  local file=$1 expr=$2 before
  before=$(mktemp)
  cp "$file" "$before"
  node -e "const fs=require('fs');const v=JSON.parse(fs.readFileSync('$file','utf8'));$expr;fs.writeFileSync('$file',JSON.stringify(v,null,2)+'\n')"
  N=$((N + 1))
  { echo "# reviewer edit: $file"; diff -u "$before" "$file" | tail -n +3; } > "$(printf '%s/%02d-reviewer-edit.diff' "$OUT" "$N")"
}
gate_path() { grep -o "$LAB/work/[^ ]*\.json" "$FILE" | head -1; }
answer_and_resume() {
  local run wait
  run=$(run_id); wait=$(wait_id)
  capture answer npx flows answer --data-dir "$DD" "$run" "$wait" yes --by "$REVIEWER"
  capture resume npx flows resume --no-observer-link --data-dir "$DD" --local-agent "$run"
}
flow() { capture "$1" npx flows run --no-observer-link --data-dir "$DD" --local-agent prompt-lab.flow.ts --input "$2"; }

echo "== Job 1: new agency sunrise / soc"
flow job1-run "{\"job\":\"new-agency\",\"reviewer\":\"$REVIEWER\",\"lab\":\"$LAB\",\"agency\":\"sunrise\",\"visitType\":\"soc\"}"
parked_on "Config workbench" || { echo "job 1 did not reach the grid gate" >&2; exit 1; }
# The reviewer's first pass: Pat's wound is open today, whatever the discharge summary said.
edit "$(gate_path)" 'const r=v.find(r=>r.questionId==="wound-status"&&r.patientId==="pat");r.target={answer:"Ongoing",confidence:"High",explanation:"Today'"'"'s visit notes describe an open 2.0 x 1.5 cm left heel wound with serous drainage and slough; the discharge summary'"'"'s closed status is outdated."};r.notes="The prompt makes the referral win over what the nurse saw today. Today'"'"'s notes must win (shared guideline 1)."'
answer_and_resume
parked_on "Commit output" || { echo "job 1 did not reach the commit gate" >&2; exit 1; }
# ostomy-supplies has no shelf patient yet, so its first-pass prompt was never run: hold it back.
edit "$(gate_path)" 'v.mode="except";v.questions=["ostomy-supplies"]'
answer_and_resume

echo "== Test patient creator: the ostomy gap brief Job 1 queued"
flow patient-run "{\"job\":\"patient\",\"reviewer\":\"$REVIEWER\",\"lab\":\"$LAB\",\"briefId\":\"gap-ostomy-supplies\"}"
parked_on "Test patient creator" || { echo "patient job did not reach kick generate" >&2; exit 1; }
answer_and_resume   # kick generate; Patient QA locks it, nobody approves the chart

echo "== Job 2: fix wound-status from the config-send issue"
ISSUE=$(node -e "const q=require('./$LAB/queue/issues.json');console.log(q.find(i=>i.questionIds[0]==='wound-status').id)")
flow job2-run "{\"job\":\"fix\",\"reviewer\":\"$REVIEWER\",\"lab\":\"$LAB\",\"issueId\":\"$ISSUE\"}"
parked_on "Question workbench" || { echo "job 2 did not reach the gold gate" >&2; exit 1; }
answer_and_resume   # gold as prefilled: Pat's config-level target travelled with the issue
parked_on "Re-run and score" || { echo "job 2 did not reach done" >&2; exit 1; }
answer_and_resume   # mark done = live, for every agency using it

echo "== Final lab state"
capture lab-state node -e "
const b=require('./$LAB/bank.json');
for (const [q,v] of Object.entries(b.questions)) console.log(q.padEnd(17),'live',String(v.livePromptId).padEnd(30),'draft',v.draftPromptId??'-');
console.log('shelf', require('fs').readdirSync('$LAB/shelf').join(' '));
console.log('issues', JSON.stringify(require('./$LAB/queue/issues.json').map(i=>[i.id,i.status])));
console.log('patient briefs', JSON.stringify(require('./$LAB/queue/patient-briefs.json').map(i=>[i.id,i.status])));
console.log('gold', Object.keys(require('./$LAB/gold.json')).join(' '));"
echo "data dir: $DD"
