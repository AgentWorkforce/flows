# Local run observer projection

`flows run` and `flows resume` project journal facts into `wf-<root-run-id>`
when a Relaycast workspace is configured. The printed link uses a scoped
`ot_live_` observer token, never the workspace key. `--no-observer-link` and
`FLOWS_NO_OBSERVER=1` suppress both token creation and publication.

YAML observation spans initial admission, out-of-band worker completion,
retries and final classification. An idempotent or recovered start watches
the existing run instead of creating another. Resume folds old facts silently;
an old terminal fact cannot close the resumed projection. Epoch summaries reset
the projected step state to the journal's retained done/open steps. Authored
child failures keep the root's channel and observer link.

The producer sends `{text, data: {relayflow: {version: 1, event, run}}}` to
Relaycast's message endpoint. Relaycast exposes that payload as
`message.metadata.relayflow` to the dashboard. Changing the request field to
`metadata` is not compatible with the message API.

After queued publication settles, the CLI retires its session publisher using
Relaycast's history-preserving agent deletion endpoint. Current Relaycast
tombstones the agent and revokes its credentials without deleting its messages.
Cleanup and publication are best-effort and bounded; an unavailable service or
abrupt process death cannot affect execution and can leave cleanup unfinished.
The journal remains the record (RFC-0001 decision 7).

Full visual acceptance requires the Relaycast observer renderer (#450) in
addition to this producer. The joint proof must show live step progression,
the final status, single-channel token scope, retained history after publisher
retirement, and unchanged execution with observation disabled/unavailable.
Mocked transport tests do not establish that deployed end-to-end behavior.
