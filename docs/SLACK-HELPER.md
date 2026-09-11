# Slack helper namespace

`f.slack` is the first provider helper on the authored TypeScript surface.
Calls return a `Step` immediately and must be awaited like `f.run` and `f.llm`.

```ts
import { flow } from '@relayflows/surface';

export default flow('notify', async f => {
  const posted = await f.slack.post('#releases', 'Release shipped');
  await f.slack.reply('#releases', posted.ts, 'Details follow');
  await f.slack.react('#releases', posted.ts, 'rocket');
  await f.slack.dm('U123', 'Release shipped');
  f.done('success');
});
```

Set `SLACK_BOT_TOKEN` or provide a relayfile mount with a `slack/` directory.
`flows check notify.flow.ts` refuses visible Slack calls when neither is
available, with `REFUSED [helper_slack.credential_missing]` and exit status 2.
A header can declare `tools: { slack: true }` for calls hidden behind another
function. The body is not evaluated during check; dynamic calls also check
credentials when they are awaited.

`RELAYFLOWS_SLACK_MOCK=1` bypasses credentials and network. Each call captures
its stamped body in `<data-dir>/mock-writeback/slack/<step-id>.json` and returns
a synthetic receipt. Message timestamps are `mock-<step-id>` and message
references are `mock-ref-<step-id>`.

The runtime uses the published `@relayfile/relay-helpers` Slack client with an
explicit transport. Relayfile receives the adapter's canonical write path;
bot-token mode calls Slack with the same flow token as `client_msg_id`.
`flowRunWritebackIdempotency(runId, stepId)` always returns `runId:stepId`.
The process-tick stamper cannot replace this token, including for reactions.

The existing kernel agent lease carries the helper's external write. Its
instruction and successful `step.completed.payload.output` carry
`{ type: 'effect', provider: 'slack', verb, params }`; output also carries the
receipt and flow idempotency token. `effect.record`/`effect.confirm` retain the
kernel's own lease key. No kernel vocabulary or protocol change is required.
Other providers can follow this transport and effect-worker pattern.

Receipts are persisted under `<data-dir>/helper-receipts/` before confirmation.
`flows resume <helper-run-id> --data-dir <data-dir>` reattaches the helper worker
and recovers the receipt. Retain the whole data directory across restarts.
The kernel retains a crashed attempt's `step.completed(crashed)` and records
exactly one successful completion on recovery. A confirmed effect is not sent
again. An unconfirmed effect is retried with its original provider token.

The authored executor still creates separate runs per step; it does not yet
have a durable journal for the whole TypeScript body. Resuming a helper run
finishes that effect, not the remainder of the authored body. Postfix callback
gates remain unsupported by this executor, as for its other current verbs.
