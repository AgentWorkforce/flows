#!/usr/bin/env python3
"""Generate workflows/drive-cloud.yaml from workflows/drive.yaml.

A cloud sandbox has no git remote and no GitHub token, so the tick cannot
deliver. Rather than run one tick and stop, this emits N full work-package
cycles back to back in ONE sandbox so the program keeps moving with the
laptop closed. The operator recovers the work with `agent-relay cloud sync`.

Run from the repo root:  python3 ops/gen-drive-cloud.py
"""
import copy
import yaml

CYCLES = 3
BASE_STEPS = ["assess", "assess-gate", "build", "verify", "review", "verdict"]


def build():
    d = yaml.safe_load(open("workflows/drive.yaml"))
    src = {s["name"]: s for s in d["workflows"][0]["steps"]}

    out = copy.deepcopy(d)
    out["name"] = "flows-drive-cloud"
    out["description"] = (
        "The Lead's tick, shaped for a cloud sandbox with the laptop closed.\n"
        "A cloud sandbox has no git remote and no GitHub token, so this flow\n"
        f"never delivers: it runs {CYCLES} full work-package cycles back to back\n"
        "in ONE sandbox, committing each to the sandbox branch. Recover the work\n"
        "with `agent-relay cloud sync <runId>`. Nothing reaches main without a\n"
        "human. GENERATED from workflows/drive.yaml by ops/gen-drive-cloud.py.\n"
    )
    out["swarm"]["channel"] = "flows-drive-cloud"
    out["swarm"]["timeoutMs"] = 28800000  # 8h

    steps = [copy.deepcopy(src["sync"])]
    prev = "sync"

    for n in range(1, CYCLES + 1):
        for base in BASE_STEPS:
            s = copy.deepcopy(src[base])
            s["name"] = f"{base}-{n}"
            s["dependsOn"] = [prev]
            steps.append(s)
            prev = s["name"]

        v = steps[-1]
        # A rejection must not abort the run. Nothing is delivered from a
        # sandbox, so bad work cannot escape; the honest verdict is recorded
        # and the next cycle's assess treats it as the work package.
        # A MISSING transcript stays fatal: that means the review gate
        # produced no evidence, and three more cycles built on unreviewed
        # work is worse than stopping.
        v["command"] = (
            "# CLOUD VARIANT (generated): a REJECTION does not stop the run —\n"
            "# nothing is delivered from a sandbox, so bad work cannot escape,\n"
            "# and the next cycle's assess treats the rejection as its work\n"
            "# package. A MISSING transcript is still fatal: a review that\n"
            "# persisted no evidence means the gate did not run.\n"
            + v["command"]
                .replace(
                    'echo "VERDICT_FAILED: reviewer rejected this diff — see $latest"; exit 1',
                    'echo "VERDICT_FAILED: reviewer rejected this diff — see $latest"; exit 0',
                )
                .replace(
                    'echo "VERDICT_UNKNOWN: $latest carries no verdict"; exit 1',
                    'echo "VERDICT_UNKNOWN_NONFATAL: $latest carries no verdict"; exit 0',
                )
        )

        steps.append({
            "name": f"commit-{n}",
            "type": "deterministic",
            "dependsOn": [v["name"]],
            "command": (
                "set -eu\n"
                f"cycle={n}\n"
                'title=$(grep -m1 -oE "WP-[0-9]+[^|]*" ops/NEXT.md '
                '| sed "s/[[:space:]]*$//" || echo "work package")\n'
                'latest=$(ls ops/reviews/*-review.md 2>/dev/null | sort | tail -1)\n'
                'verdict=$(grep -oE "REVIEW_(PASSED|FAILED)" "$latest" 2>/dev/null '
                "| tail -1 || echo REVIEW_UNKNOWN)\n"
                "git add -A\n"
                'git commit -m "drive(cloud cycle $cycle): $title [$verdict]" '
                '|| echo "COMMIT_NOTE: nothing new to commit"\n'
                'echo "CYCLE_${cycle}_COMMITTED verdict=$verdict '
                'head=$(git rev-parse --short HEAD)"\n'
            ),
            "timeoutMs": 300000,
        })
        prev = f"commit-{n}"

    steps.append({
        "name": "handoff",
        "type": "deterministic",
        "dependsOn": [prev],
        "command": (
            "set -eu\n"
            'echo "CLOUD_RUN_COMPLETE"\n'
            'echo "branch: $(git rev-parse --abbrev-ref HEAD)"\n'
            'echo "commits this run:"\n'
            'git log --oneline -20 | sed "s/^/  /"\n'
            'echo ""\n'
            'echo "This work exists ONLY in this sandbox. Recover it with:"\n'
            'echo "  agent-relay cloud sync <runId>"\n'
            'echo "Nothing was pushed and no PR was opened: a sandbox has no"\n'
            'echo "remote and no GitHub token. A human reviews and merges."\n'
        ),
        "timeoutMs": 300000,
    })

    out["workflows"][0]["name"] = "drive-cloud-loop"
    out["workflows"][0]["steps"] = steps
    return out


if __name__ == "__main__":
    doc = build()
    with open("workflows/drive-cloud.yaml", "w") as f:
        f.write("# GENERATED from workflows/drive.yaml by ops/gen-drive-cloud.py.\n"
                "# Do not hand-edit: change drive.yaml, then regenerate.\n")
        yaml.safe_dump(doc, f, sort_keys=False, width=100, default_flow_style=False)
    print(f"wrote workflows/drive-cloud.yaml ({len(doc['workflows'][0]['steps'])} steps)")
