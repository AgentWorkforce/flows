# F1 evidence: what each capture is

Every file is the unedited output of the command on its first `$` line. A red
capture is a snapshot of an intermediate working tree, taken before that change's
implementation existed. It does not reproduce from any commit, because each commit
holds both the tests and the code that turns them green. That is why each red
capture states its code state here.

| File | Code state | What it shows |
|---|---|---|
| `01-signals-red.txt` | Base `fe60dd4c` + the new reader tests | The 4 review-feedback reader tests fail: no `reviewFeedback` yet. |
| `02-standalone-red.txt` | `signals.ts` reader signature already changed; `standalone.ts` not yet | The 3 new flow tests fail. So does the pre-existing "reader is asked for this bot's reports", because `standalone.ts` still passed `botLogin` as a string to the new object parameter (hence the character-indexed object in its output). The next step fixed that call site. |
| `03-own-agents-red.txt` | First F1 implementation + the `ownAgents` tests | The 3 `ownAgents` tests fail. |
| `10-shared-login-red.txt` | `b1a5809b` + the shared-login test | An unmarked `botLogin` comment moves the window. |
| `11-garden-scope-red.txt` | Shared-login fix + the Garden-scope test | A `relayflow/*` PR without the label is declined. |
| `12-garden-draft-red.txt` | `b9c6924c` + the Garden-draft test | A Garden draft is declined. |
| `13-review-round1-red.txt` | `c176f9c9` + the review-round-1 tests | File-level, pending-review timing, equal-second, own-agent directive and file-path rendering tests fail. |
| `04-all-babysitter-green.txt` | Branch head | Full suite: 0 failures. |
| `05-artifact-check.txt` | Branch head | Artifact digest reproduces. |
| `06-typecheck.txt` | Branch head | Typecheck with the literal environment filter (see its header). |
| `07-flows-check.txt` | Branch head | `flows check` on the artifact. |
| `08-sdk-shipped-source.txt` | Branch head | Shipped-source model pins. |
| `09-mutation.txt` | Branch head | Literal snapshot, `sed`, `diff`, red run, `cp` restore, `cmp`, green run. |
