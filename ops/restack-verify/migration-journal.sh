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

# Validate lineage, then compare snapshot payloads. Lineage alone cannot tell a
# stale snapshot from an intentional drop, so the content comparison is what
# gives this gate teeth: drizzle snapshots are cumulative, so anything present
# in a predecessor and absent from its successor is either a deliberate removal
# or a snapshot that was rebuilt from the wrong base. Columns are compared as
# well as tables — the defect this gate was written for was a snapshot missing
# a single jsonb column, which a table-name comparison alone would have passed.
#
# A removal that is deliberate is recorded once in ACK_PATH, one
# `<snapshot file>:<table>` or `<snapshot file>:<table>.<column>` per line.
# Without that escape hatch a single legitimate DROP TABLE — or a RENAME, which
# drizzle snapshots as a drop plus a create — fails this gate on every future
# run forever, and a permanently red gate gets deleted rather than fixed.
ACK_PATH = "ops/restack-verify/intentional-drops.txt"
acknowledged = set()
if os.path.exists(ACK_PATH):
    for raw in open(ACK_PATH):
        line = raw.split("#", 1)[0].strip()
        if line:
            acknowledged.add(line)

snaps = sorted(f for f in os.listdir(d) if f.endswith("_snapshot.json"))
previous = "00000000-0000-0000-0000-000000000000"
seen = set()
previous_tables = None
previous_columns = {}
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
    tables = snapshot.get("tables")
    if not isinstance(tables, dict):
        problems.append(f"{name}: tables must be an object")
        continue
    columns = {}
    for tname, tbody in tables.items():
        cols = tbody.get("columns") if isinstance(tbody, dict) else None
        columns[tname] = set(cols) if isinstance(cols, dict) else set()

    if previous_tables is not None:
        lost = [t for t in sorted(previous_tables - set(tables))
                if f"{name}:{t}" not in acknowledged]
        if lost:
            problems.append(
                f"{name}: removed tables require semantic schema verification "
                f"(intentional drop or stale snapshot): {lost}"
            )
        for tname in sorted(set(tables) & previous_tables):
            lost_cols = [c for c in sorted(previous_columns.get(tname, set()) - columns[tname])
                         if f"{name}:{tname}.{c}" not in acknowledged]
            if lost_cols:
                problems.append(
                    f"{name}: table {tname} lost columns present in its predecessor "
                    f"(intentional drop or stale snapshot): {lost_cols}"
                )
    previous_tables = set(tables)
    previous_columns = columns

if problems:
    print("RESTACK_VERIFY migration-journal: FAILED")
    for x in problems:
        print(f"  - {x}")
    raise SystemExit(1)
print(f"RESTACK_VERIFY migration-journal: PASSED ({len(entries)} entries, tail {tags[-1] if tags else 'none'})")
PY
