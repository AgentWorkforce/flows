#!/usr/bin/env python3
"""Read one local standalone reproduction's SQLite journals."""

import json
import sqlite3
import sys
from pathlib import Path


data = Path(sys.argv[1])
root_id = sys.argv[2]
runs = sorted((data / "runs").glob("*.sqlite3"))
root = sqlite3.connect(data / "runs" / f"{root_id}.sqlite3")
root_spawn = next(json.loads(payload) for kind, payload in root.execute(
    "select entry_type, payload from entries where entry_type='run.spawned'"
) if kind == "run.spawned")
metadata = json.loads(root_spawn["spec"]["steps"][0]["instruction"])
print("root executionMode:", metadata["executionMode"])

attempts = 0
routes = []
for path in runs:
    entries = sqlite3.connect(path).execute(
        "select entry_type, at_ms, payload from entries order by seq"
    ).fetchall()
    attempts += sum(kind == "step.attempt.started" for kind, _, _ in entries)
    spawned = next((json.loads(payload) for kind, _, payload in entries
                    if kind == "run.spawned"), None)
    if spawned is None:
        continue
    step = spawned["spec"]["steps"][0]
    command = step.get("command", "")
    if not any(f"{name}-start" in command for name in "ABC"):
        continue
    started = next(at for kind, at, _ in entries if kind == "step.attempt.started")
    ended = next(at for kind, at, _ in entries if kind == "step.completed")
    routes.append((step["id"], started, ended))

for step_id, started, ended in sorted(routes):
    print(f"{step_id}: started={started} ended={ended}")
print("route start spread ms:", max(start for _, start, _ in routes)
      - min(start for _, start, _ in routes))
print("all routes overlapped:", max(start for _, start, _ in routes)
      < min(end for _, _, end in routes))
print("run journals:", len(runs), "attempt starts:", attempts)
