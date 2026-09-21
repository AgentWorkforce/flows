# extension-babysitter (offline fixture)

The worked schema-2 `kind: "flow-extension"` manifest for Babysitter on
Software Garden, served to the SDK tests by a fake GitHub (see
`packages/sdk/tests/plugin-extension.test.ts` and
`tests/flow-extension-compose.test.ts`). It is a fixture, not an installable
example: the entry carries Babysitter's handler surface — one `.on()` per
declared subscription — over a body that only declines, so composition onto a
base flow can be proven without the real review body. `extends.hooks` is empty
because this fixture does not declare a hook; declared hooks are composed when
the base flow names them. The `merge-gate` hook from the design is not included
in this fixture.

Babysitter's own subscription contract (branch `feat/babysitter-v2`) names
eleven GitHub subscriptions. Three of them — `pull_request.ready_for_review`,
`pull_request.labeled`, `pull_request.unlabeled` — are not in the surface
event registry (`providerEventTypes`), so a manifest declaring them is refused
with `plugin_event_unroutable`; this fixture lists only the eight the registry
can lower. Extending the registry is a separate change and is not claimed here.
