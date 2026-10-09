# Babysitter fixer (standalone): fix PR feedback, propose, never push

`fixer.ts` is the standalone Babysitter that fixes what woke it. Cloud launches it
the same way it launches the diagnose-only `standalone.ts` (STANDALONE.md, "Launch
input"). Admission is shared (`admission.ts`): it admits only the bound PR, fails
closed without origin context, binds the live head to the server-claimed head,
applies the Software Garden / `babysit` label scope, and declines when nothing is
actionable.

The exact deployable source is `artifacts/babysitter-fixer.flow.ts`. Its byte
count and SHA-256 are in `artifacts/babysitter-fixer.manifest.json`. Merging this
enables nothing: Cloud must admit that digest (see "Cloud contract" below).

## Why it proposes instead of pushing

The sandbox never holds a push credential. Cloud's PR head mode writes a
contents-write token to a file the same-uid agent can read. A GitHub App token
cannot be limited to one branch, so a prompt-injected agent could push anywhere
in the repository. Cloud's `RULING-sandbox-push-0902` forbids push credentials
in sandboxes. The run therefore keeps only the read and issue-comment token
from #4226, and Cloud publishes server-side.

## Body, after admission

1. **Check out the bound head** in `babysitter-checkout` under the run root.
   - The read token is sent as an HTTP header through `GIT_CONFIG_*`, never in
     argv or in `.git/config`. Hooks are disabled.
   - Before any git command runs with the token, `.git/config` is replaced
     with a minimal known config and `.git/hooks` and `.git/info/attributes`
     are removed: a previous agent turn may have written them.
   - An existing checkout (a reused sandbox) is fetched, reset to the head and
     cleaned in place. Ignored files, such as installed dependencies, survive.
   - **Per-PR reuse (C2):** Cloud may hand a later wake the same sandbox.
     Each run root is created anew, so the checkout lives in
     `$HOME/.babysitter/<owner>/<repo>/<pr>/checkout` between runs. It is
     moved (renamed, dependencies included) into the run root before
     `checkoutHead`, and moved back after the run, whatever its outcome,
     before `f.done`. If the cache is on another filesystem, or damaged, the
     run starts fresh.
2. **One agent** (`babysitter-fix`, the origin session's CLI, with a literal
   pinned model per CLI, ignoring the policy's `agentCli`) runs in that
   checkout. Its task opens with the origin's first prompt, verbatim and
   fenced, then lists what changed with review comment ids. It is told to edit
   only, to never touch workflows or secrets, and to end with
   `{"summary", "replies": [{id, body}]}`.
3. **Reread before proposing.** If the head moved or the PR left scope, the
   run declines with no proposal.
4. **One journaled proposal**, the stdout of one deterministic `f.run`:
   ```jsonc
   {
     "kind": "babysitter-proposal", "schemaVersion": 1,
     "pullRequest": { "owner": "acme", "repo": "widgets", "number": 7 },
     "baseHead": "<bound head sha>",
     "files": ["src/queue.ts"],            // git diff --name-only --no-renames
     "patch": "diff --git …",              // git diff --cached --binary --full-index <baseHead>
     "summary": "<neutralised markdown>",  // ≤ 4,000 chars, origin prompt redacted
     "replies": [{ "commentId": 11, "body": "<!-- babysitter:reply acme/widgets#7@<head> -->\n…" }]
   }
   ```
   - The patch includes the agent's own commits, because it is taken against
     the bound head.
   - The agent can write `.git`. So `.git/config`, hooks and
     `info/attributes` are reset before `git add`/`git diff` run, and the
     diff passes `--no-ext-diff --no-textconv --src-prefix=a/
     --dst-prefix=b/`. A planted external diff, clean filter or hook never
     runs, and the patch format is fixed (`evidence/f2-fixer/07`: the
     pre-fix code did run both).
   - Limits: patch ≤ 36,000 bytes, ≤ 50 files, whole proposal ≤ 50,000 bytes
     (the kernel keeps a 64 KiB stdout tail).
   - Paths are read NUL-delimited, and the diff uses `core.quotePath=false`.
     A path git would still have to quote (a quote, backslash or control
     character) refuses the proposal, so the paths Cloud parses back out of
     the patch are exactly the ones checked here.
   - Any path under `.github/workflows/`, `.env*`, keys and certificates,
     `id_*` SSH keys, `.npmrc`/`.netrc`/`.pypirc`, or `secret(s)/` makes the
     run print `{"kind": "babysitter-refusal"}` instead. The run then ends
     `needs_human`.
   - Replies are kept only for inline feedback that woke this run, at most one
     per thread, bounded, with mentions neutralised.
5. `f.done('success')`. The run never commits, pushes, merges, approves,
   requests changes or comments.

## Cloud contract (to implement: C1')

On `workflows/callback` completion of a run whose source SHA-256 equals the
fixer manifest's, under the same idempotent claim pattern as
`pushAllowedPathPatches`:

1. **Find the proposal.** The executor lifts the last deterministic step
   `stdout_tail` that parses as a `babysitter-proposal`, the same way it lifts
   `pullRequestUrl` today, into the run report.
2. **Bind to server authority, never to the proposal.**
   - The owner, repo, PR and head come from the run's
     `babysitter_standalone_run_claims` row and its lineage.
   - `baseHead` must equal the claimed head.
3. **Re-check every limit server-side**: refused paths, file count and size.
   Re-derive `files` from the patch, and refuse fork heads.
4. **Push fast-forward only.**
   - Build one commit whose **parent is the bound head**
     (`github-push-back.ts` `buildCommitOperations` at that SHA).
   - Then `PATCH refs/heads/<headRef>` with **`force: false`**. A head that
     moved is refused by GitHub, so the check is atomic.
   - `commitViaGitDatabaseRequest` forces today, so it needs a non-forcing
     variant.
5. **Publish replies and a summary** with the server token.
   - Post each reply to `/pulls/:n/comments/:commentId/replies`.
   - Post one issue comment carrying `<!-- babysitter:report <pr>@<head> -->`,
     the new commit and the summary.
6. **Never merge or review.** No merge, approve or request-changes call
   exists on this path.

## Verify

```bash
node --experimental-strip-types --test examples/babysitter/tests/fixer.test.ts
node examples/babysitter/build-standalone.mjs --check
node packages/sdk/dist/cli.js check examples/babysitter/artifacts/babysitter-fixer.flow.ts
```

Literal output: `evidence/f2-fixer/`.
