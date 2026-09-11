Generated TypeScript helpers; do not edit the `.ts` files. Run
`npm run gen --prefix packages/surface` from the repository root (or `npm run gen`
inside this package). This repository has no root npm workspace, so
`npm run gen -w @relayflows/surface` is not available.

This minimal slice ships Slack's four existing journal-backed methods. Argument
shapes come from the pinned `@relayfile/relay-helpers` declaration; return types
come from the existing surface dispatcher contract, including `reply`'s `ref`.
`Ctx` extends the generated `Helpers` namespace map. A union of namespace maps
would make only their common properties accessible, so composition uses an
interface instead.

To consume a read-only adapter checkout before release:
`node scripts/generate-helpers.mjs --adapters-dir /path/to/relayfile-adapters`.
Use `--out-dir /tmp/generated-helpers` to inspect output without changing source.
CI regenerates from the installed pinned package and compares every generated
TypeScript file byte-for-byte, including the namespace index.

Follow-up for the full slice N: add GitHub, Notion, Linear, and Stripe once their
methods have runtime dispatch support; consume mapping/discovery resources and
generate the remaining providers. The current runtime implements only Slack.
The uniform upstream clients expose resource `read`/`list`/`write` methods,
not `stripe.createInvoice` or `notion.appendBlock`; those aliases need an agreed
runtime contract before this types-only generator can expose them. GitHub's
bespoke `createIssue` also requires `owner` in addition to `repo`, `title`, and
`body`. No new provider methods or resource methods are advertised in this proof.
