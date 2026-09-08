# Example gallery

These four examples describe larger flows. **None has a green end-to-end
result in the WS-13 verification run.** The table records time until refusal
or the verification timeout, not time to successful completion.

| Example | What it demonstrates | Observed result | Time |
|---|---|---|---:|
| [dependency-upgrade-bot](dependency-upgrade-bot/) | Upgrade → independent verification → PR | Refused: unsupported `budget` header, exit 2 | [6.596s](../docs/evidence/ws13/gallery-dependency-upgrade-bot.txt) |
| [pr-review-pipeline](pr-review-pipeline/) | Three review lenses → consensus | Refused: unsupported `budget` header, exit 2 | [4.990s](../docs/evidence/ws13/gallery-pr-review-pipeline.txt) |
| [social-post-pipeline](social-post-pipeline/) | Research → draft → fact-check → graphic → human approval | Refused: unsupported `budget` header, exit 2 | [6.698s](../docs/evidence/ws13/gallery-social-post-pipeline.txt) |
| [research](research/) | Claude/Codex/Grok fan-out → synthesis via existing shims | Verification timed out with no output captured | [150.067s](../docs/evidence/ws13/gallery-research.txt) |

The first three were invoked individually with the packed candidate CLI,
`--local-agent`, explicit inputs, and separate local daemon directories.
Research was invoked through its documented shim with a one-minute per-step
bound and a 150-second outer verification bound; the latter does not establish
whether preflight or execution was responsible. Exact commands and captured
output are linked in the table. These are runs on an existing development
host, not a clean machine.

Removing the unsupported headers or weakening the examples' artifact gates
would change what they promise. Further runtime work is required before these
can be advertised as runnable. Social-post-pipeline additionally depends on
`f.human`; workspace permission annotations and postfix gates also remain
unsupported by the authored executor.

The research example's `npm run typecheck` command now uses the actual
`packages/sdk` compiler path. Its shim tests and typecheck are separate from
an end-to-end run.
