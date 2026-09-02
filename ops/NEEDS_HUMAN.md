# NEEDS_HUMAN — gate 3 scope unreachable from kernel/ snapshot

**Run ID:** 67b27712-a9e3-4348-895d-be1fd9254abf
**Gate:** 3 (per ops/TARGET.md)
**Blocker:** Required file paths do not exist in this sandbox snapshot

## The exact question

**How should gate 3 work be scoped when the cloud sandbox contains only a kernel/ subdirectory snapshot without `.github/` or build toolchains?**

## What ops/TARGET.md requires

ops/TARGET.md pins this run to gate 3 with scope:

> **Track D: Cloud review-swarm redesign** — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts.
>
> Add / rewrite:
>   - `.github/workflows/review-swarm.yml` — the GHA trigger
>   - `.github/workflows/scripts/swarm-post.sh` — sync + verdict + post script
>   - `.github/workflows/scripts/swarm-prepare.sh` — launcher-side fetcher
>   - `workflows/review-swarm.yaml` — aggregate step refactored
>   - `.gitignore` — drop the `.review-target` mask
>   - `README.md` — document `RELAY_WORKSPACE_KEY` secret

Definition of done includes:
- All files parse (python yaml check; bash -n for scripts)
- `cd sdk && npm test` green
- `cd kernel && cargo test` green (via ops/cargo.sh)
- `git status --porcelain` as final action

## What this snapshot contains

Directory tree present:
```
.
├── kernel/         (relayflowd Rust workspace)
├── sdk/            (TypeScript SDK, but no node/npm available)
├── workflows/      (relay workflow definitions)
├── ops/
├── docs/
├── charter/
└── (others)
```

**Missing:**
- `.github/` directory (and all subdirectories)
- git repository (stub file points to missing `/home/daytona/.project-git`)
- Build toolchains (no cargo, no npm, no node)

**Evidence:**

```
$ ls -la .github/
ls: cannot access '.github/': No such file or directory
```

```
$ git log --oneline -15
fatal: not a git repository: /home/daytona/.project-git
```

```
$ cargo test --workspace
/usr/bin/zsh: line 1: cargo: command not found
```

```
$ cd sdk && npm test
/usr/bin/zsh: line 1: cd: sdk: No such file or directory
```

## Why this blocks gate 3 work

1. **Cannot create required files** — the scope requires creating `.github/workflows/review-swarm.yml` and scripts in `.github/workflows/scripts/`, but the `.github/` directory does not exist in this tree

2. **Cannot satisfy definition of done** — requires `npm test` and `cargo test` green, but no build toolchains are available in this sandbox environment

3. **Cannot verify with git status** — final DoD step requires `git status --porcelain`, but there's no git repository

4. **Snapshot propagation is unclear** — per ops/STATE.md, cloud sandboxes run in `SYNC_MODE=snapshot` where "the uploaded tree is committed as its own base." Creating a new top-level `.github/` directory in a kernel/-rooted snapshot may not propagate correctly to the real repo structure.

## Conflict with existing ops/NEXT.md

The file ops/NEXT.md (present when this run started) specifies a DIFFERENT scope:

> **Scope:** Build a minimal agent worker in the SDK. CODE task, SDK-side.

That conflicts with ops/TARGET.md's gate 3 cloud review-swarm scope. Per the brief:

> It is the operator's scoping decision and it overrides your own judgement about priority

ops/TARGET.md is the authoritative scope for this run.

## Options

**Option A: Relaunch with full repo snapshot**
Modify the cloud run launcher to upload the complete repo tree including `.github/`, not just a kernel/ subtree. This would make all target file paths reachable.

**Option B: Gate 3 work happens locally, not in cloud**
The immutable-gate architecture (requirement #1 in TARGET.md: two checkout steps, main's gate files judge PR head) and GHA secret requirements may mean cloud review-swarm work needs a real GitHub environment with `gh` auth, not a detached cloud sandbox.

**Option C: Partial gate 3 work in this snapshot**
Scope down to only the parts achievable without `.github/` — e.g., refactoring `workflows/review-swarm.yaml`'s aggregate logic (TARGET.md requirement #2: unified verdict-extraction logic). Skip the GHA wrapper until a different run type has the full tree.

**Option D: ops/NEXT.md scope is correct, TARGET.md stale**
The stale ops/NEXT.md (SDK agent worker) is actually the right gate 3 work, and ops/TARGET.md's cloud review-swarm scope belongs to a different track that should not have been assigned to this run.

## Recommended resolution

**Option A** appears most aligned with the charter's instruction to stay inside the assigned target. If gate 3 work is genuinely `.github/workflows/` changes, the launcher should provide a snapshot where those paths exist.

Alternatively, **Option D** if the human operator confirms the SDK agent worker scope (from existing ops/NEXT.md) is the intended gate 3 work and ops/TARGET.md was written for a different parallel run.

## What I did NOT do

Per the brief ("stay inside your target or report blocked, do not silently choose different work"), I did NOT:
- Start working on the SDK agent worker from the stale ops/NEXT.md
- Create a `.github/` directory in this kernel/ snapshot
- Modify `workflows/review-swarm.yaml` without confirming that's a valid partial scope
- Attempt to run tests that would fail due to missing toolchains

This run ends with no code changes, only this NEEDS_HUMAN report, because the assigned scope is unreachable from the starting state.
