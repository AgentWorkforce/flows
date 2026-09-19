#!/usr/bin/env python3
"""Generate workflows/drive-cloud-v2.yaml from workflows/drive.yaml.

The v2 kernel spec of the cloud tick. Cloud submits this with
`--relayflow-version v2`, which routes the launch through the Cloudflare
queue instead of the SQS/Lambda bridge, so retiring that Lambda needs this
file to exist and be equivalent to drive-cloud.yaml.

This translates rather than re-authors: it reuses gen-drive-cloud.build(),
so the cloud-specific shaping (one cycle, non-fatal verify, commit/handoff)
has exactly one definition and drive.yaml stays the single source of truth.
Regenerate both together:

    python3 ops/gen-drive-cloud.py && python3 ops/gen-drive-cloud-v2.py

The mapping is mechanical because the v2 authoring schema kept v1's
camelCase for everything the tick uses -- `dependsOn`, `maxIterations`,
`timeoutMs` and `verification` are unchanged, gates included. What moves:

  version: '1.0'          -> '0.1.0'         (kernel rejects other values)
  workflows[0].steps      -> steps           (v2 has no workflows wrapper)
  step.name               -> step.id
  agent step .task        -> .instruction
  swarm.timeoutMs         -> budget.maxWallclockMs
  swarm.channel           -> agent step surfaces.streams[].stream
  swarm.pattern: dag      -> dropped; dependsOn already IS the dag

Two v1 concepts have no v2 equivalent and are handled explicitly below:
the `agents` roster and its `preset`.
"""
import copy
import importlib.util
import sys

import yaml

SPEC_VERSION = "0.1.0"

# Mirrors kernel/relayflowd-core/src/spec.rs STEP_*_FIELDS. The kernel
# rejects unknown step fields (SpecError::UnknownField) rather than ignoring
# them, so a field this translator forgets to map is a hard launch failure,
# not a silent behaviour change. Asserting the key sets here turns that into
# a generator-time error with the offending field named.
STEP_COMMON_FIELDS = {
    "id",
    "type",
    "dependsOn",
    "input",
    "maxIterations",
    "retry",
    "verification",
    "memory",
    "requirements",
}
STEP_FIELDS_BY_TYPE = {
    "deterministic": {"command", "timeoutMs", "lease_ms"},
    "llm": {"prompt", "model", "cli"},
    # No timeoutMs: agent steps are bounded only by budget.maxWallclockMs.
    # That is not a regression from v1, where the comments in drive.yaml
    # record that timeoutMs on agent steps was never enforced anyway.
    "agent": {
        "instruction",
        "agent",
        "cli",
        "model",
        "cwd",
        "output",
        "transport",
        "recoveryMode",
        "surfaces",
        "permissions",
    },
}


def load_v1_cloud_doc():
    """The v1 cloud doc, straight from the existing generator."""
    spec = importlib.util.spec_from_file_location(
        "gen_drive_cloud", "ops/gen-drive-cloud.py"
    )
    module = importlib.util.module_from_spec(spec)
    # Importing a sibling script would otherwise leave ops/__pycache__ behind
    # on every run, which is untracked noise in `git status`.
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module.build()


def translate_step(v1_step, agents_by_name, channel):
    step = copy.deepcopy(v1_step)
    step_type = step.get("type")

    step["id"] = step.pop("name")

    if step_type == "agent":
        step["instruction"] = step.pop("task")
        # Inline the roster entry's cli instead of emitting an `agents` map.
        # The v2 roster (NamedAgentSpec) requires BOTH cli and model, and
        # drive.yaml declares no model -- emitting one would mean inventing a
        # model pin for the lead and builder here, which is a behaviour change
        # disguised as a port. An inline cli is what the already-ported
        # workflows/drive-local.yaml does, and it carries v1's mapping exactly.
        agent_name = step.pop("agent", None)
        if agent_name is not None:
            agent = agents_by_name.get(agent_name)
            if agent is None:
                raise SystemExit(
                    f"step {step['id']}: references undeclared agent {agent_name!r}"
                )
            step["cli"] = agent["cli"]
            # `preset` has no v2 equivalent. `role` does not either, but it is
            # load-bearing prose -- it is how drive.yaml tells the lead it is
            # the Lead -- so it is carried into the instruction rather than
            # dropped. Prefixed, not appended: the instruction ends with the
            # ASSESS_DONE contract that the verification gate reads.
            role = agent.get("role")
            if role:
                step["instruction"] = f"{role}\n\n{step['instruction']}"
        # v1's swarm.channel, per-step. Without this the agent is not a
        # participant on a named stream and cannot be steered mid-run.
        if channel:
            step["surfaces"] = {"streams": [{"stream": channel}]}
        # Not enforced in v1 and not accepted in v2.
        step.pop("timeoutMs", None)

    allowed = STEP_COMMON_FIELDS | STEP_FIELDS_BY_TYPE.get(step_type, set())
    unknown = sorted(set(step) - allowed)
    if unknown:
        raise SystemExit(
            f"step {step['id']} (type {step_type}): the kernel rejects "
            f"unknown fields {unknown}; teach this translator to map them"
        )
    return step


def build():
    v1 = load_v1_cloud_doc()
    swarm = v1.get("swarm") or {}
    agents_by_name = {a["name"]: a for a in v1.get("agents") or []}

    out = {
        "version": SPEC_VERSION,
        "name": v1["name"],
        "description": v1["description"].replace(
            "GENERATED from workflows/drive.yaml by ops/gen-drive-cloud.py.",
            "GENERATED from workflows/drive.yaml by ops/gen-drive-cloud-v2.py.",
        ),
    }

    wallclock = swarm.get("timeoutMs")
    if wallclock:
        out["budget"] = {"maxWallclockMs": wallclock}

    out["steps"] = [
        translate_step(s, agents_by_name, swarm.get("channel"))
        for s in v1["workflows"][0]["steps"]
    ]
    return out


def assert_equivalent_to_v1(v2, v1):
    """The port must not change what the tick does.

    Schema validity is not the property that matters here -- a spec that
    passes the schema but drops a gate, reorders the dag or rewrites a shell
    command is a silently different flow. So this compares the two documents
    field by field and fails on anything the mapping above does not explain.
    """
    swarm = v1.get("swarm") or {}
    agents_by_name = {a["name"]: a for a in v1.get("agents") or []}
    v1_steps = v1["workflows"][0]["steps"]

    assert v2["version"] == SPEC_VERSION, v2["version"]
    assert v2["name"] == v1["name"], v2["name"]
    assert v2.get("budget", {}).get("maxWallclockMs") == swarm.get("timeoutMs")
    # Same steps, same order: dependsOn encodes the dag, but order is what a
    # reader diffs, and a reordered emit would hide a dropped step.
    assert [s["id"] for s in v2["steps"]] == [s["name"] for s in v1_steps]

    for new, old in zip(v2["steps"], v1_steps):
        where = f"step {new['id']}"
        assert new["type"] == old["type"], where
        assert new.get("dependsOn") == old.get("dependsOn"), where
        assert new.get("maxIterations") == old.get("maxIterations"), where
        # Gates are control flow. v1 and v2 share the gate shape exactly, so
        # this is an identity check, not a translation.
        assert new.get("verification") == old.get("verification"), where

        if old["type"] == "deterministic":
            # Byte-identical: every one of these commands encodes a hard-won
            # sandbox fact (exec bits, 413 flushes, stale trees). Reflowing
            # one would be a behaviour change no reviewer would spot.
            assert new["command"] == old["command"], where
            assert new.get("timeoutMs") == old.get("timeoutMs"), where
        elif old["type"] == "agent":
            agent = agents_by_name[old["agent"]]
            assert new["cli"] == agent["cli"], where
            expected = old["task"]
            role = agent.get("role")
            if role:
                expected = f"{role}\n\n{expected}"
            assert new["instruction"] == expected, where
            assert new["surfaces"]["streams"][0]["stream"] == swarm["channel"], where
            assert "timeoutMs" not in new, where


if __name__ == "__main__":
    doc = build()
    path = "workflows/drive-cloud-v2.yaml"

    assert_equivalent_to_v1(doc, load_v1_cloud_doc())

    if "--check" in sys.argv:
        # Drift gate: a hand-edit, or a drive.yaml change landed without
        # regenerating, must fail rather than be silently overwritten later.
        with open(path) as f:
            on_disk = yaml.safe_load(f)
        if on_disk != doc:
            raise SystemExit(
                f"{path} is stale; run: python3 ops/gen-drive-cloud-v2.py"
            )
        print(f"{path} is current and equivalent to drive-cloud.yaml", file=sys.stderr)
        raise SystemExit(0)

    with open(path, "w") as f:
        f.write(
            "# GENERATED from workflows/drive.yaml by ops/gen-drive-cloud-v2.py.\n"
            "# Do not hand-edit: change drive.yaml, then regenerate.\n"
        )
        yaml.safe_dump(doc, f, sort_keys=False, width=100, default_flow_style=False)
    agents = sum(1 for s in doc["steps"] if s["type"] == "agent")
    print(
        f"wrote {path} ({len(doc['steps'])} steps, {agents} agent)",
        file=sys.stderr,
    )
