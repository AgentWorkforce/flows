# PR #408 remediation — document-root retry policy

## Scope

Addressed Cursor Bugbot finding `541a84d5-8a39-4538-a52f-737822ca332d`:
the legacy workflow runner reads `errorHandling` from the document root, so
the per-agent blocks in the drive and watchdog workflows were unsupported.

The remediation puts `strategy: retry` and `retryDelayMs: 60000` at each
affected document root, deliberately leaves the runner-owned retry count
unset, removes all affected agent-level overrides, regenerates the cloud
projection, and removes the one-shot migration artifacts that documented the
unsupported shape.

## Starting remote head

The sweep inventory recorded this head for PR #408:

```console
$ git show a05ebe0f:docs/evidence/pr-sweep-0917/inventory.md | rg -n -C 5 '408|drive'
24:| #408 | `d9634429a626f24f6ff5d3e54b58ae938866cec7` | kjgbot | no | MERGEABLE | none | 1 | Gate 3-adjacent workflow reliability; **fix_required** (review FAILURE, thread). |
```

The pull ref fetched before work matched it:

```console
$ git ls-remote origin 'refs/pull/408/head'
d9634429a626f24f6ff5d3e54b58ae938866cec7	refs/pull/408/head

$ git fetch --no-tags origin refs/pull/408/head:refs/remotes/origin/pr-408 && git rev-parse refs/remotes/origin/pr-408
d9634429a626f24f6ff5d3e54b58ae938866cec7
```

The PR source branch was established from GitHub, not inferred from the pull
ref:

```console
$ gh pr view 408 --repo AgentWorkforce/flows --json number,headRefName,headRepositoryOwner,headRefOid,baseRefName,title,url,mergeable,state
{"baseRefName":"main","headRefName":"cloud/run-f06e1c98","headRefOid":"d9634429a626f24f6ff5d3e54b58ae938866cec7","headRepositoryOwner":{"id":"O_kgDODwX6VQ","login":"AgentWorkforce"},"mergeable":"UNKNOWN","number":408,"state":"OPEN","title":"drive: cloud run f06e1c98","url":"https://github.com/AgentWorkforce/flows/pull/408"}
```

## Deterministic verification

The existing repository reliability check rejects a retry delay shorter than
60 seconds. It and its negative controls passed:

```console
$ bash .github/workflows/scripts/swarm-definition.test.sh
ok: valid candidate passes
ok: short retry delay
ok: changed timeout
ok: invalid YAML
ok: symbolic-link candidate
swarm-definition: all tests passed
```

The same existing validator accepted each affected workflow at its document
root:

```console
$ for workflow in workflows/drive.yaml workflows/drive-cloud.yaml workflows/watchdog.yaml; do
>   .github/workflows/scripts/swarm-definition.sh "$workflow" "$workflow"
> done
CANDIDATE_DEFINITION_OK
retry strategy=retry retryDelayMs=60000 timeoutMs=10800000
CANDIDATE_DEFINITION_OK
retry strategy=retry retryDelayMs=60000 timeoutMs=3600000
CANDIDATE_DEFINITION_OK
retry strategy=retry retryDelayMs=60000 timeoutMs=1800000
```

The structural assertion independently verifies that every affected document
has exactly the root policy and zero agent-level overrides:

```console
$ ruby -ryaml -e '
> paths = %w[workflows/drive.yaml workflows/drive-cloud.yaml workflows/watchdog.yaml]
> paths.each do |path|
>   document = YAML.safe_load(File.read(path), aliases: false)
>   policy = document.fetch("errorHandling")
>   raise "#{path}: wrong policy" unless policy == { "strategy" => "retry", "retryDelayMs" => 60_000 }
>   overrides = document.fetch("workflows").flat_map { |workflow| workflow.fetch("steps") }.select { |step| step["type"] == "agent" && step.key?("errorHandling") }
>   raise "#{path}: retained agent overrides" unless overrides.empty?
>   puts "#{path}: root retry policy=retry/60000; agent overrides=0"
> end
> '
workflows/drive.yaml: root retry policy=retry/60000; agent overrides=0
workflows/drive-cloud.yaml: root retry policy=retry/60000; agent overrides=0
workflows/watchdog.yaml: root retry policy=retry/60000; agent overrides=0
```

The patch contains no whitespace errors:

```console
$ git diff --check
```

## Commit and branch head

Remediation commit: `021fb7395b94cebd364af11a338bdbbd133b9d5f`

Final exact branch head for the remediation changes:
`021fb7395b94cebd364af11a338bdbbd133b9d5f`

The evidence-record commit is created separately after this record is written;
it contains no workflow behavior change.

## Pre-push remote-head check

Before any push, both the PR source branch and the pull ref were fetched again
and required to equal the sweep head:

```console
$ set -euo pipefail
$ starting_head=d9634429a626f24f6ff5d3e54b58ae938866cec7
$ git fetch --no-tags origin refs/heads/cloud/run-f06e1c98:refs/remotes/origin/cloud/run-f06e1c98 refs/pull/408/head:refs/remotes/origin/pr-408
$ remote_branch_head=$(git rev-parse refs/remotes/origin/cloud/run-f06e1c98)
$ remote_pull_head=$(git rev-parse refs/remotes/origin/pr-408)
$ printf 'remote branch head: %s\n' "$remote_branch_head"
remote branch head: d9634429a626f24f6ff5d3e54b58ae938866cec7
$ printf 'remote pull head: %s\n' "$remote_pull_head"
remote pull head: d9634429a626f24f6ff5d3e54b58ae938866cec7
$ printf 'starting head: %s\n' "$starting_head"
starting head: d9634429a626f24f6ff5d3e54b58ae938866cec7
$ test "$remote_branch_head" = "$starting_head"
$ test "$remote_pull_head" = "$starting_head"
$ printf 'REMOTE_HEAD_UNCHANGED\n'
REMOTE_HEAD_UNCHANGED
```
