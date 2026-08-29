# NEEDS HUMAN — Gate 3 definition of done is unreachable

The current work package requires `TOTAL=32 ACTIONABLE>=20` while changing only
scope extraction. It also explicitly forbids changing `definition_of_done`.

Against the current `ops/BACKLOG.md`, only 14 entries have a non-empty
`definition_of_done`, even when `files_in_scope` is forcibly made non-empty for
every entry. Therefore no scope-only implementation can make 20 entries pass
`validateWorkPackage`.

Reproduction:

```sh
node <<'NODE'
const fs = require('node:fs');
const sdk = require('./sdk/dist/backlog-picker.js');
const text = fs.readFileSync('ops/BACKLOG.md', 'utf8');
const entries = [...text.matchAll(/^- \*\*(.+?)\*\*\s*(.*(?:\n  .*)*)/gm)]
  .map((match) => ({
    title: match[1],
    body: match[2].replace(/\s+/g, ' ').trim(),
  }));
let actionable = 0;
for (const entry of entries) {
  const work = sdk.packageFromEntry(entry);
  work.files_in_scope = ['forced-valid-scope'];
  if (sdk.validateWorkPackage(work).accepted) actionable++;
}
console.log(`TOTAL=${entries.length} MAX_WITH_ALL_SCOPE_VALID=${actionable}`);
NODE
```

Captured output:

```text
TOTAL=32 MAX_WITH_ALL_SCOPE_VALID=14
```

Human resolution is required: either update the backlog/work package so at
least 20 entries independently satisfy the existing definition-of-done rule,
lower the actionable threshold to at most 14, or explicitly authorize a change
to definition-of-done extraction. No SDK implementation was made because it
could not satisfy the stated gate without violating its hard constraints.
