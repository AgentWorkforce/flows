# extension-babysitter (offline fixture)

The worked schema-2 `kind: "flow-extension"` manifest for Babysitter on
Software Garden, served to the SDK tests by a fake GitHub (see
`packages/sdk/tests/plugin-extension.test.ts`). It is a fixture, not an
installable example: the entry is a stub, and runtime composition of flow
extensions is refused with `plugin_unsupported` in this release.

Babysitter's own subscription contract (branch `feat/babysitter-v2`) names
eleven GitHub subscriptions. Three of them — `pull_request.ready_for_review`,
`pull_request.labeled`, `pull_request.unlabeled` — are not in the surface
event registry (`providerEventTypes`), so a manifest declaring them is refused
with `plugin_event_unroutable`; this fixture lists only the eight the registry
can lower. Extending the registry is a separate change and is not claimed here.
