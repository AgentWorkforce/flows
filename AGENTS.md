# Working in flows

- Read `docs/RFC-0001-everything-is-a-relayflow.md`. Kernel logic stays pure and simulated-clock testable; SDKs and surfaces cross the journal protocol only.
- Journal write failures fail the step; completions carry completionReason. Preserve crash/resume and exactly-once effect proofs. Never edit the gate judging your own work.
- Use a branch; a human merges. Only the designated Lead has the exact-head exception in settled decision 16; it does not apply to ordinary workers.
- The journal is authoritative. Relaycast and the observer are projections; local runs are valid. Cloud mirroring is explicit opt-in because it uploads source, transcripts and output.
- Watchable runs use `scripts/run-workflow.sh`; observer links contain scoped observer tokens, never workspace keys. Do not expose credentials in evidence.
- Verification claims require literal commands and captured, redacted output. A mutation-verification claim requires a captured fail/revert/restore/pass sequence.

## Agency and guidance

- Act autonomously on routine assigned work; ask forgiveness rather than permission. Preserve explicit production, release and credential gates.
- For guidance, ask the engineering leads, the agent that spawned you, or the layered owner on Agent Relay.
- Only a truly pressing or blocking question goes to `khaliq-gant` or `will-washburn` on Agent Relay.

## Cross-repo context

- Before and during changes, understand how this repo fits the wider system; consult its repo map and related-repo docs where available.
- Check relevant agents’ summaries on Agent Relay and proactively contact owning agents about dependencies, adjacent changes and work in flight.

## Pull requests (when used)

- Open PRs as ready for review by default. If merging requires Khaliq’s OK, use `merge-train:hold` instead of draft status.
- If you open a PR, immediately subscribe to its feedback through Agent Relay using [this skill](https://github.com/AgentWorkforce/skills/blob/main/skills/subscribing-relay-webhooks-and-writebacks/SKILL.md), and verify subscription readiness.
- Evaluate each review finding. Address applicable feedback and explain declined changes in the thread.
- A PR is not ready while feedback remains unaddressed or merge conflicts remain.
- When ready, alert the CODEOWNERS and the agent that spawned you on Agent Relay.
- Keep related open PRs from going stale: find their authoring agent on Agent Relay and coordinate; if that agent is no longer on the relay, escalate to the CODEOWNERS or the layered owner.
