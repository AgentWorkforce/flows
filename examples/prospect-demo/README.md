# Prospect demo

Generate a short message with `f.llm`, post it to Slack's `#test` channel with
`f.slack.post`, and open the observer URL printed by `flows run`.

You need Node.js 22.18+, an installed and authenticated Claude CLI, a relayfile
Slack mount connected to your workspace with permission to post in `#test`,
and a Relaycast workspace key for the observer link. Create `#test` and invite
the connected Slack bot before running the demo.

Copy `demo.flow.ts` into a new directory, then run these commands there:

```sh
npm init -y
npm pkg set type=module
npm install relayflows @relayflows/surface
cat > flows.json <<'JSON'
{ "cli": "claude" }
JSON
```

To use an authenticated Codex CLI instead, change `"claude"` to `"codex"` in
`flows.json`. The LLM step uses that CLI's configured model and credentials.

Point to your existing relayfile mount and configure the observer workspace:

```sh
export RELAYFILE_MOUNT_PATH='/absolute/path/to/your/relayfile-mount'
export RELAYCAST_WORKSPACE_KEY='rk_live_REPLACE_WITH_YOUR_WORKSPACE_KEY'
```

The mount must contain a working `slack/` integration that confirms delivery.
Setting `SLACK_BOT_TOKEN` alone is not enough: the current Slack helper requires
relayfile writeback. See the [Slack helper documentation](../../docs/SLACK-HELPER.md).
If `agent-relay` already has an active workspace saved locally, you can omit
`RELAYCAST_WORKSPACE_KEY`; the CLI uses that workspace automatically.

Check the flow and run it:

```sh
npx flows check demo.flow.ts
npx flows run demo.flow.ts --local-agent --input '{}'
```

With `flows` on your PATH, the equivalent command is
`flows run demo.flow.ts --local-agent --input '{}'`. The local worker runs the
LLM call; the Slack helper waits for a delivery receipt before completing.
Each new run posts a new message to `#test`.

On success, look for the generated message in Slack and a terminal line like:

```text
Observer: https://agentrelay.com/observer?key=ot_live_...
```

Open that URL to view the configured Relaycast workspace. The CLI mints the
observer token and prints the link; the flow needs no separate observer call.
If the line is missing, check the workspace key, unset `FLOWS_NO_OBSERVER`, and
look for an `[observer]` diagnostic. `flows observer` can mint a link separately.
The link uses a scoped observer token, not the workspace key.

For a local preview without sending a Slack message, prefix the run command
with `RELAYFLOWS_SLACK_MOCK=1`. The LLM call still runs, but Slack delivery is
replaced by a local receipt; this does not demonstrate live Slack delivery.
