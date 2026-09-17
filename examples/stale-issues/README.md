# stale-issues

A scheduled automation: fetch every open issue (deterministic, journaled), let
one LLM step classify them as stale / needs-attention with a JSON schema gate,
and post a single Slack digest.

```sh
RELAYFLOWS_SLACK_MOCK=1 flows check examples/stale-issues/stale-issues.flow.ts   # mock until Slack is connected
flows schedule examples/stale-issues/stale-issues.flow.ts \
  --cron "0 9 * * 1-5" --tz Europe/Oslo \
  --input '{"repo":"acme/api","channel":"#eng","staleDays":14}'
flows schedules
```

`flows schedule` ships in the release after 2.0.16. Until then the same flow
runs on demand from anywhere with a token:

```sh
GH_TOKEN=… flows run --cloud --wait examples/stale-issues/stale-issues.flow.ts \
  --input '{"repo":"acme/api","channel":"#eng"}'
```

The Slack helper needs `tools: { slack: true }` in the header and a connected
Slack workspace (`flows.json` / Cloud connections); locally,
`RELAYFLOWS_SLACK_MOCK=1` records the post instead of sending it.
