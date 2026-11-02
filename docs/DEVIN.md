# Devin agent steps

Use the installed `devin` executable for an agent step:

```yaml
version: '0.1.0'
steps:
  - id: implement
    type: agent
    cli: devin
    instruction: Fix the failing test and explain the change.
    timeoutMs: 600000
```

An optional `model` is passed through `--model`. Execution uses `devin -p
--prompt-file <private task file> --permission-mode dangerous
--respect-workspace-trust false`. Its printed response is the step result.
Devin is an agent harness; `llm` steps are refused at preflight.

For hosted land flows, provide a Devin CLI login token as the
`LAND_DEVIN_API_KEY` workspace secret. The Cloud land credential alias
([Cloud #5926](https://github.com/AgentWorkforce/cloud/pull/5926)) supplies it to
the agent runtime as `DEVIN_API_KEY`; local runs set `DEVIN_API_KEY` directly.
This is the token stored as `windsurf_api_key` by CLI login; a Devin REST API
key is a different credential. The verified
Devin CLI release `3000.11.234` does not read that variable itself. The worker
writes it as `windsurf_api_key` in a private `credentials.toml`, selects that
attempt's XDG data/config/cache directories, and removes the private state
when execution ends, fails, or is aborted. The original home and interactive
credentials are untouched. Local runs without the variable use the existing
Devin login from `devin auth login`.

Preflight checks the executable and authenticates with `devin models list
--format json`; `devin auth status` exits zero even when logged out. An
explicit model is checked with a headless model round trip.

Print mode provides no authoritative token usage. Every Devin step warns
`budget_unmetered`, including steps with a priced model: token and dollar
ceilings cannot measure its spend. Set a timeout to bound its duration.

Broker skill installation uses the supported Windsurf target, whose
`.windsurf/skills` directory Devin also reads.
