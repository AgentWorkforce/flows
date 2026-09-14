# Relay agent task transport

An agent step with `transport: 'relay'` waits for a durable final task receipt.
Spawn readiness and invocation acceptance do not complete the Flows step.

This adapter requires the task contract in AgentWorkforce/relaycast#436
(`c80202f2dfe7a15a6cef5b81f2452b1d7acd6add`) and its provider in
AgentWorkforce/relay#1772 (`6a06fd176df94ca1054d5b7965bd777b7d881eb6`;
subsequent proof-only commit `a8577736dd32c0bcf51a37f88ac0b04fb056da3f`).
These changes need to be admitted and deployed in that order before a live
Cloud proof can validate this adapter. The independent schema-validation fix in AgentWorkforce/flows#398 is also an
explicit validate dependency; its patch is not included here. Local wire fixtures do not establish
that the deployed service supports the contract.

Configure a pre-provisioned `RELAY_AGENT_TOKEN` for the caller in the provider's
workspace and, if needed, `RELAY_BASE_URL` (default `https://cast.agentrelay.com`).
A workspace API key cannot substitute for the agent token. HTTPS is required
except for literal loopback IP addresses used in local development. The Relay provider
must explicitly enable `AGENT_RELAY_TASK_PROVIDER=1` with persistent state.
The worker uses its injected `agent_result` tool to submit the final output or
failure and waits for the provider's durable acknowledgment before exiting.

Flows resolves the caller with `GET /v1/agent` and invokes
`POST /v1/actions/task.run/invoke`. The journal idempotency key identifies the
invocation; the input carries run, step, dispatch identity, model, working
directory, result schema, wake context, and a 24-hour task deadline. The adapter
uses the pinned engine's `action-invoke-v1` deterministic invocation ID so it
can reconcile a lost POST acknowledgment without another POST.

Before dispatch, Flows exclusively creates and syncs a private claim under its
durable data directory's `relay-tasks/`. It binds the canonical engine origin,
workspace, caller, invocation, journal identity, and full input. The data
directory must survive runner restarts; it includes the task prompt and needs
the same protection as the journal. Tokens are never stored in the claim.
A corrupt claim or changed caller, endpoint, or input fails closed. Token
rotation for the same caller remains possible.

Only the original claim creator sends a POST. Resumed or ambiguous dispatches
use `GET /v1/actions/task.run/invocations/:id` exclusively. If the task cannot be
confirmed, Flows reports an explicit failure; it never creates another task
under a replacement principal. A terminal failure is immutable for that
journal identity, including on a retry of the same dispatch. Starting a new
logical task requires a new journal identity.

While polling, Flows renews the existing worker lease. Lease loss aborts polling
and prevents a stale journal completion. Execution identity must remain stable across every observed receipt. Generation
and acceptance time may appear together once and must then remain stable; final receipts must match the caller, invocation,
input, run, step, and dispatch. A completed receipt supplies the exact JSON
output, including arrays, scalars, and null. A failed receipt supplies an
explicit failure reason. Receipt correlation is retained in the step's
trajectory metadata. Known credential values are redacted from error details.

Optional accounting counters `tokens_input` and `tokens_output` feed existing
model pricing. A priced task without the required usage still fails the
existing usage check. Cancellation of local polling does not invent a remote
cancellation API; the durable provider and engine task deadline govern the
remote execution. Historical terminal receipts can still be recovered after
the deadline.
