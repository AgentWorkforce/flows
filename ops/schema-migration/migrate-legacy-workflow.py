#!/usr/bin/env python3
"""Migrate a legacy 1.0 relayflow YAML to the 0.1.0 authoring schema.

The 1.0 schema wrapped a swarm definition around one or more named workflows.
0.1.0 is a single flow: one top-level `steps` array, agents as a map of named
{cli, model} declarations. Every legacy file in this repo declares exactly one
workflow, so the structural change is a lift, not a split.

This script REFUSES rather than guesses. Anything it cannot place is reported
and the file is not written, because a migration that silently drops a field is
worse than one that fails: the flow would run, look fine, and mean something
different. What legitimately has no home in 0.1.0 is listed in
ops/schema-migration/README.md and carried into the migrated file as comments,
so the loss stays visible to the next reader.
"""
import sys, yaml

FLOW = {'version', 'name', 'description', 'cli', 'agents', 'triggers', 'steps', 'budget'}
AGENT_DECL = {'cli', 'model'}
STEP_COMMON = {'id', 'type', 'dependsOn', 'verification', 'maxIterations', 'memory', 'requirements'}
STEP_BY_TYPE = {
    'deterministic': {'command', 'timeoutMs'},
    'llm': {'prompt', 'model', 'cli', 'output'},
    'agent': {'instruction', 'agent', 'cli', 'model', 'surfaces', 'recoveryMode', 'permissions', 'output'},
}
# Legacy keys we drop on purpose, with the reason recorded in the output file.
DROPPED_TOP = {'swarm'}
DROPPED_AGENT = {'preset', 'role'}      # persona surface (RFC decision 9)
DROPPED_STEP = {('agent', 'timeoutMs')}  # 0.1.0 bounds deterministic steps only


def migrate(path):
    raw = yaml.safe_load(open(path))
    problems, notes = [], []

    # Refuse a schema this tool was not written for. Without this, a 0.2.0 file
    # would be silently restamped as 0.1.0 and "migrated" by guesswork.
    src_version = str(raw.get('version'))
    if src_version != '1.0':
        # Return, do not accumulate. Continuing into the legacy loops with a
        # schema this tool does not understand means `a.get(...)` raises on a
        # 0.1.0-style agents MAP and the caller sees a traceback instead of the
        # clean refusal this script promises.
        return None, [f"source version is {src_version!r}, expected '1.0'; "
                      "this tool migrates the 1.0 schema only"], notes

    unknown_top = set(raw) - FLOW - DROPPED_TOP - {'workflows'}
    if unknown_top:
        problems.append(f"unhandled top-level keys: {sorted(unknown_top)}")

    workflows = raw.get('workflows') or []
    if len(workflows) != 1:
        problems.append(f"expected exactly one workflow, found {len(workflows)}; "
                        "a multi-workflow file must be split by hand, not guessed")

    if 'swarm' in raw:
        s = raw['swarm']
        notes.append(f"legacy swarm dropped: {s} - 0.1.0 has no run-level "
                     "pattern/channel/timeout slot")

    agents, roles = {}, {}
    for a in raw.get('agents') or []:
        name = a.get('name')
        if not name:
            problems.append(f"agent declaration without a name: {a}")
            continue
        decl = {k: v for k, v in a.items() if k in AGENT_DECL}
        leftover = set(a) - AGENT_DECL - DROPPED_AGENT - {'name'}
        if leftover:
            problems.append(f"agent {name}: unhandled fields {sorted(leftover)}")
        if a.get('role'):
            roles[name] = a['role']
        if a.get('preset'):
            notes.append(f"agent {name}: preset '{a['preset']}' dropped - "
                         "presets are persona surface (RFC decision 9)")
        agents[name] = decl

    steps = []
    for s in (workflows[0].get('steps') if workflows else []) or []:
        t = s.get('type')
        out = {'id': s.get('name'), 'type': t}
        if not out['id']:
            problems.append(f"step without a name: {s}")
        allowed = STEP_COMMON | STEP_BY_TYPE.get(t, set())
        for k, v in s.items():
            if k == 'name':
                continue
            if k == 'task' and t == 'agent':
                # An agent's role described who it was; the 0.1.0 step carries
                # the whole contract, so the role is prepended rather than lost.
                role = roles.get(s.get('agent'))
                out['instruction'] = f"{role}\n\n{v}" if role else v
            elif k == 'agent' and t == 'agent':
                # 0.1.0 requires `model` in a named agent declaration and the
                # legacy schema never carried one. Rather than invent a model,
                # carry the agent's `cli` onto the step, which is the same
                # information the legacy file actually held. Verified against
                # the SDK: an agent step with `cli` and no agents map compiles;
                # an agents map with `cli` and no `model` is refused.
                cli = (agents.get(v) or {}).get('cli')
                if not cli:
                    problems.append(f"step {out['id']}: agent '{v}' has no cli to carry")
                else:
                    out['cli'] = cli
                notes.append(f"step {out['id']}: agent reference '{v}' became cli "
                             f"'{cli}' - 0.1.0 named declarations require a model "
                             "the legacy file never had")
            elif k in allowed:
                out[k] = v
            elif (t, k) in DROPPED_STEP:
                notes.append(f"step {out['id']}: {k}={v} dropped - "
                             "0.1.0 bounds deterministic steps only")
            else:
                problems.append(f"step {out['id']}: unhandled field '{k}' for type {t}")
        steps.append(out)

    if problems:
        return None, problems, notes
    # Carry every 0.1.0 field the source actually set. `cli`, `triggers` and
    # `budget` pass the unknown-key check above because they ARE valid 0.1.0
    # fields; emitting a fixed dict dropped them silently, which is the exact
    # failure this script's docstring refuses to commit. Absent optionals are
    # omitted rather than written as null, because an explicit null is not a
    # valid value for them.
    out = {'version': '0.1.0'}
    for key in ('name', 'description', 'cli', 'triggers', 'budget'):
        # An absent key and a key explicitly set to null are different facts.
        # Treating null as absent would silently drop a field the author wrote
        # down, which is the exact failure this script refuses elsewhere.
        if key not in raw:
            continue
        if raw[key] is None:
            problems.append(f"{key} is explicitly null; remove the key or give "
                            "it a value -- this tool will not guess which you meant")
            continue
        out[key] = raw[key]
    if problems:
        return None, problems, notes
    out['steps'] = steps
    return out, [], notes


if __name__ == '__main__':
    src = sys.argv[1]
    spec, problems, notes = migrate(src)
    if problems:
        print(f"REFUSED {src}")
        for p in problems:
            print(f"  - {p}")
        raise SystemExit(1)
    header = [f"# Migrated from the legacy 1.0 schema by "
              f"ops/schema-migration/migrate-legacy-workflow.py.",
              "# Deliberate losses, recorded so they are not rediscovered as bugs:"]
    header += [f"#   - {n}" for n in notes] or ["#   (none)"]
    out = "\n".join(header) + "\n" + yaml.safe_dump(spec, sort_keys=False, width=100)
    # No implicit in-place rewrite. Defaulting dest to src meant that running
    # this with a single argument silently destroyed the input -- the exact
    # "guessing on the author's behalf" this tool exists to refuse. An
    # in-place migration is still available, but only when asked for by name.
    if len(sys.argv) > 2:
        dest = sys.argv[2]
    else:
        sys.stderr.write(
            f"refusing to migrate {src} in place: pass an explicit destination, "
            f"or '{src}' again if you really mean to overwrite it\n")
        sys.exit(2)
    open(dest, 'w').write(out)
    print(f"MIGRATED {src} -> {dest} ({len(spec['steps'])} steps, {len(notes)} recorded losses)")
