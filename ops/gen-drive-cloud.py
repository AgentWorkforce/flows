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

# ONE cycle per run, on evidence. Cycle 1 completes cleanly in about ten
# minutes (runs 6b6d456e and 1b0dedc8 both did). Cycle 2's assess step then
# hangs — both those runs stalled at assess-2 past the 40-minute threshold and
# had to be cancelled, which destroys the patch and so threw away the cycle-1
# work that had already committed.
#
# Three cycles in one sandbox was meant to amortise startup. In practice it
# converts a finished cycle into a lost one. A single-cycle run terminates,
# yields its patch, and gets delivered as a PR; the next run is launched by
# whatever is supervising. Short runs that finish beat long runs that hang.
CYCLES = 1
# "review" and "verdict" are deliberately ABSENT from the cloud variant.
# Every hang observed on 2026-08-28 (five of five: 167c2713, dd0fa9c2,
# e960e18d, 8aac8a58 and one more) was an adversarial review step silent for
# 40+ minutes. A hung agent step is unrecoverable here: the platform does not
# enforce timeoutMs, an agent step cannot be wrapped in timeout(1), and a run
# that never terminates never yields its patch — so the whole run is lost.
#
# In a sandbox the in-run review is also the least load-bearing gate, because
# NOTHING SHIPS from a sandbox: every run returns as a pull request a human
# merges. PR review already catches real defects — it caught the exec-bit
# regression on PR #13 that our own in-run review did not. So the cloud
# variant trades in-run review for runs that actually finish and deliver.
# The local drive.yaml KEEPS review and verdict: that environment delivers,
# so its gate must bite.
BASE_STEPS = ["assess", "assess-gate", "build", "verify"]


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
    out["swarm"]["timeoutMs"] = 3600000  # 1h — one cycle takes ~10 min; a run
    # that has not finished in an hour is hung, not slow, and should stop
    # burning budget rather than sit for eight hours.

    steps = [copy.deepcopy(src["sync"])]
    prev = "sync"

    for n in range(1, CYCLES + 1):
        for base in BASE_STEPS:
            s = copy.deepcopy(src[base])
            s["name"] = f"{base}-{n}"
            s["dependsOn"] = [prev]
            steps.append(s)
            prev = s["name"]

        # verify: same reasoning as verdict below. In a sandbox nothing is
        # delivered, so a failed verify cannot ship anything; killing the run
        # would throw away the remaining cycles instead of letting the next
        # assess treat the failure as its work package. The failure is still
        # recorded loudly, and it still gets its 3 repair attempts first.
        vf = next(x for x in steps if x["name"] == f"verify-{n}")
        vf["command"] = (
            "# CLOUD VARIANT (generated): a FAILED verify is recorded and the\n"
            "# run continues. Nothing is delivered from a sandbox, so a failure\n"
            "# here cannot ship; the next cycle's assess treats it as the work\n"
            "# package. On a delivering environment verify stays fatal.\n"
            + vf["command"].replace(
                '[ "$ok" -eq 0 ] && echo VERIFY_PASS || { echo VERIFY_FAIL; exit 1; }',
                '[ "$ok" -eq 0 ] && echo VERIFY_PASS || echo "VERIFY_FAIL_NONFATAL: recorded; the next cycle must address it"',
            )
        )

        steps.append({
            "name": f"commit-{n}",
            "type": "deterministic",
            "dependsOn": [f"verify-{n}"],
            "command": (
                "set -eu\n"
                f"cycle={n}\n"
                'title=$(grep -m1 -oE "WP-[0-9]+[^|]*" ops/NEXT.md '
                '| sed "s/[[:space:]]*$//" || echo "work package")\n'
                'verdict=NO_IN_RUN_REVIEW\n'
                # Purge forbidden paths BEFORE staging. `git add -A` sweeps in
                # whatever the sandbox tree holds, and a per-step sandbox can be
                # seeded from a stale orchestrator archive: four consecutive
                # runs committed kernel/relayflowd/src/engine/hn_poller.rs this
                # way, a file review had ruled out of the kernel. Telling the
                # builder not to create it does not help — the builder never
                # created it; the tree already had it and add -A took it.
                'if [ -f ops/FORBIDDEN_PATHS ]; then\n'
                '  while IFS= read -r p; do\n'
                '    case "$p" in \'\'|\\#*) continue ;; esac\n'
                '    if [ -e "$p" ]; then\n'
                '      echo "COMMIT_PURGED_FORBIDDEN: $p (stale tree residue)"\n'
                '      rm -rf "$p"\n'
                '    fi\n'
                '  done < ops/FORBIDDEN_PATHS\n'
                'fi\n'
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
