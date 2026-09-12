# Generated provider helpers

`Ctx` exposes the relayfile helper clients as lazy journaled steps. For example:

```ts
await f.github.createIssue({ repo: 'owner/repo', title: 'Investigate', body: 'Details' });
await f.linear.createIssue({ teamId: 'team-id', title: 'Investigate' });
await f.stripe.createInvoice({ customer: 'cus_123' });
await f.asana.tasks.write({}, { name: 'Investigate' });
await f.googleDrive.files.write({}, { name: 'Report' });
```

Provider names with hyphens become camelCase namespaces. Resource names retain
upstream spelling (`f.github['issue-comments'].write(...)`). The upstream
resource clients expose `write`, `read`, `list`, and a pure `path` resolver.
All asynchronous methods become `Step`s; `path` performs no I/O.

A provider directory must exist under the first configured nonempty mount root:
`RELAYFILE_MOUNT_PATH`, `WORKSPACE_ROOT`, `WORKFORCE_SANDBOX_ROOT`,
`RELAYFILE_MOUNT_ROOT`, or `RELAYFILE_ROOT`. Direct provider tokens are not a
transport. Explicit declarations such as `tools: { github: true }` and direct
body references are checked before the body runs; dynamic aliases are checked
when their steps execute.

`RELAYFLOWS_<PROVIDER>_MOCK=1` enables mock delivery for available providers.
Uppercase provider names and replace hyphens with underscores, for example
`RELAYFLOWS_GOOGLE_DRIVE_MOCK=1`. Mock writes are captured under
`<data-dir>/mock-writeback/<provider>/`; mock reads return an empty object and
mock lists return an empty array. These are test responses, not provider data.

Writes use `(run id, step id)` as the writeback idempotency key. Collection
paths receive stable draft filenames; item paths remain canonical. Delivery
must be confirmed before the receipt is persisted and the journal effect is
confirmed. Resume recovers the receipt, and repeats only an unconfirmed effect
using its original key. Provider failures complete with `worker_error`;
journal and receipt-storage failures fail closed.

## Regeneration

```sh
npm run gen --prefix packages/surface
node scripts/generate-helpers.mjs --adapters-dir /path/to/relayfile-adapters
```

The pinned published catalog and helper clients provide reproducible API types
and runtime factories. `--adapters-dir` additionally walks every adapter package
to discover providers that have not published writeback clients. Generated
files include factories, namespace types, a runtime client registry, and
preflight metadata. An unpublished client is marked unavailable rather than
assigned invented writeback paths.

## Upstream gaps in slice S

The supplied provider list contains 48 names including the five original
providers. The pinned catalog also includes GitLab and Ramp, so regeneration
currently emits 50 namespaces. Forty have runtime clients. These ten are
explicitly unavailable, including in mock mode:

- airtable
- docker-hub
- fathom
- gcp
- neon
- posthog
- segment
- shopify
- webhook-server
- x

The supplied checkout's catalog lists all except webhook-server under
`ADAPTERS_WITHOUT_WRITEBACK_PATHS`. Webhook-server is infrastructure, not a
writeback provider. These require upstream client/catalog work before slice S
can meet its full provider acceptance bar.

Stripe has an adapter writeback route for invoice creation but no exported
helper client. The invoice convenience wrapper submits that existing route
through the shared transport and consumes `created()` from relay-helpers.

`f.notion.appendBlock({ pageId, block })` is **mock-only**. The supplied Notion
adapter supports page content replacement and comments, but no append-block
writeback route. Real mount execution is refused before starting the effect;
mock execution can test types and journal lowering. This is an outstanding
acceptance gap, not live append-block support. Existing catalog Notion
resources continue to use the upstream client.

No triggers or direct-token transports are added by this slice.
