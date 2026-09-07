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
entries = j.get("entries", [])
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
if whens and whens[-1] != max(whens):
    problems.append(
        f"last entry {tags[-1]} (when={whens[-1]}) does not sort last; max is {max(whens)}"
    )

# Cumulative snapshots: the newest must not have FEWER tables than the one
# before it. Renumbering a migration to the end without regenerating its
# snapshot shrinks the schema silently.
snaps = sorted(f for f in os.listdir(d) if f.endswith("_snapshot.json"))
if len(snaps) >= 2:
    def tables(f):
        return set(json.load(open(os.path.join(d, f))).get("tables", {}))
    prev, last = tables(snaps[-2]), tables(snaps[-1])
    lost = sorted(prev - last)
    if lost:
        problems.append(
            f"{snaps[-1]} is missing tables present in {snaps[-2]}: {lost}"
        )

if problems:
    print("RESTACK_VERIFY migration-journal: FAILED")
    for x in problems:
        print(f"  - {x}")
    raise SystemExit(1)
print(f"RESTACK_VERIFY migration-journal: PASSED ({len(entries)} entries, tail {tags[-1] if tags else 'none'})")
PY
