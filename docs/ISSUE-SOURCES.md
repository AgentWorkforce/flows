# Issue inputs and source filters

Import `matchesIssue`, `Issue`, and `SourceFilters` from `@relayflows/surface`
instead of generating a validator and matcher in every flow. The helper is
pure: it validates a normalized issue and applies the configured filters. It
does not connect an account, subscribe to events, fetch tickets, or write to a
provider.

```ts
import { flow, matchesIssue, type SourceFilters } from "@relayflows/surface";

const sources = {
  linear: { team: "Engineering", labels: ["ready-for-agent"] },
  github: { repository: "acme/app", labels: ["ready-for-agent"] },
} satisfies SourceFilters;

export default flow<{ issue: unknown }>("implement-ticket",
  { budget: { wallclock: "1h" } }, async (f, input) => {
    if (!matchesIssue(input.issue, sources)) return f.done("canceled");
    await f.agent("implementer", {
      cli: "claude",
      task: input.issue.title + "\n" + input.issue.body,
    });
    f.done("needs_human");
  });
```

This example runs the selected coding agent and stops for human inspection;
it does not create or merge a pull request. The agent must be installed and
authenticated. A dollar budget additionally requires model pricing; the
example uses a wall-clock limit so agent sign-in is sufficient for that step.

## Input contract

An `Issue` has `source`, `title`, `body`, and `labels`. The source is one of
`github`, `linear`, `shortcut`, `jira`, `slack`, or `markdown`. Optional fields
are `repository`, `team`, `workspace`, `project`, `channel`, `path`, and the
boolean `mentioned`. Identifiers and labels are strings, and `labels` is an
array even when empty. Provider-specific payloads must be normalized before
using this contract.

`matchesIssue(input, sources)` returns a type predicate. A match narrows an
unknown input to `Issue`. Malformed inputs or filter configurations return
`false`; a malformed configured source is not silently ignored. It does not
mutate either argument.

| Source | Supported filters |
| --- | --- |
| GitHub | `repository`, `labels` |
| Linear | `team`, `project`, `labels` |
| Shortcut | `workspace`, `project`, `labels` |
| Jira | `project`, `labels` |
| Slack | `channel`, `contains`, `mentioned: true` |
| Markdown | `path` |

Only explicitly configured sources match. `{ linear: {} }` permits any valid
Linear issue. All configured filters for a source must match. Every requested
label is required. Text, labels, and identifiers compare after trimming and
lowercasing; `contains` searches the title and body together. Channel matching
ignores one leading `#`. Markdown paths compare exactly, including case. To
allow Slack messages without mentions, omit `mentioned`.

## CLI and Cloud

The CLI can receive normalized input directly with `--input flow-input.json`:

```json
{
  "issue": {
    "source": "linear",
    "title": "Fix the login error",
    "body": "Add a regression test for expired sessions.",
    "labels": ["ready-for-agent"],
    "team": "Engineering"
  }
}
```

After installing the CLI and surface release containing these helpers:

```sh
npx flows check implement-ticket.flow.mts
npx flows run --local-agent implement-ticket.flow.mts --input flow-input.json
```

An excluded issue completes the authored flow with `canceled` (CLI exit 1).
An explicit failed review can use `f.done("step_failed")` (exit 1); a successful
handoff uses `f.done("needs_human")` (exit 3). These outcomes are recorded in the
terminal step's JSON output before the CLI reports them. The terminal marker
itself is a successful kernel step, as with the existing human-handoff marker;
it is not a kernel cancellation or a durable authored-root state. Authored-root
resume remains a separate runtime capability. Failure to write the terminal
marker fails the execution rather than reporting the requested outcome.

Cloud must supply the same normalized `input.issue`. Its integration adapter
owns converting a provider event into this shape, including resolving provider
IDs to the names used by the chosen filters when necessary. Passing a raw
`EventFrameV1` or an OAuth connection to `matchesIssue` is not normalization.
Filter configuration does not register a trigger.

Provider operations such as `f.github.createPullRequest` use the existing
[Relayfile helper transport](HELPERS-RUNTIME.md). Cloud must authorize and
mount the selected connection for the run. The pure issue helper does not
change those requirements or add a second provider transport.

The builder should adopt this API only after the release is available to both
its local install command and Cloud runtime. Intermediate onboarding previews
may omit later steps; the final artifact must include its input, repository,
agent and integration setup, and a working launch path.
