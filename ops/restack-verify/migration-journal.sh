#!/bin/sh
# Verify a drizzle migration journal is internally coherent after a merge.
#
# Skips cleanly when the repo has no such journal — this flow is meant to be
# runnable in any checkout, and "not applicable" must not read as "failed".
set -eu
JOURNAL="packages/web/drizzle/meta/_journal.json"
if [ ! -f "$JOURNAL" ]; then
  echo "RESTACK_VERIFY migration-journal: SKIPPED (no $JOURNAL)"
  exit 0
fi
python3 - "$JOURNAL" <<'PY'
import json, os, sys
p = sys.argv[1]
d = os.path.dirname(p)
sqldir = os.path.dirname(d)
j = json.load(open(p))
if not isinstance(j, dict) or not isinstance(j.get("entries"), list):
    print("RESTACK_VERIFY migration-journal: FAILED (entries must be a list)")
    raise SystemExit(1)
entries = j["entries"]
tags = [e["tag"] for e in entries]
problems = []

dupes = sorted({t for t in tags if tags.count(t) > 1})
if dupes:
    problems.append(f"duplicate journal tags: {dupes}")

missing = [t for t in tags if not os.path.exists(os.path.join(sqldir, f"{t}.sql"))]
if missing:
    problems.append(f"journal entries with no .sql file: {missing}")

on_disk = {f[:-4] for f in os.listdir(sqldir) if f.endswith(".sql")}
orphans = sorted(on_disk - set(tags))
if orphans:
    problems.append(f".sql files with no journal entry: {orphans}")

# The tail must sort last. A renumbered migration whose `when` was not raised
# above the new base is the exact defect this catches -- drizzle selects by
# timestamp, never by filename.
whens = [e["when"] for e in entries]
if any(a >= b for a, b in zip(whens, whens[1:])):
    problems.append("journal timestamps must be strictly increasing in entry order")

# Snapshot lineage is structural. Table sets are not monotonic: a legitimate
# DROP TABLE removes tables. Proving SQL/schema equivalence needs database
# replay, which this structural check does not claim to perform.
snaps = sorted(f for f in os.listdir(d) if f.endswith("_snapshot.json"))
previous = "00000000-0000-0000-0000-000000000000"
seen = set()
for name in snaps:
    snapshot = json.load(open(os.path.join(d, name)))
    ident = snapshot.get("id")
    if not isinstance(ident, str) or not ident or ident in seen:
        problems.append(f"{name}: missing or duplicate snapshot id")
    if snapshot.get("prevId") != previous:
        problems.append(f"{name}: prevId does not match predecessor {previous}")
    if isinstance(ident, str):
        seen.add(ident)
    previous = ident

if problems:
    print("RESTACK_VERIFY migration-journal: FAILED")
    for x in problems:
        print(f"  - {x}")
    raise SystemExit(1)
print(f"RESTACK_VERIFY migration-journal: PASSED ({len(entries)} entries, tail {tags[-1] if tags else 'none'})")
PY
