# Backlog — durable, below directives

Items the Lead should weigh in assess after ops/DIRECTIVES.md and the current
gate's needs. Not commitments; ordering is the Lead's call with evidence.

- **Release pipeline (relay pattern, NOT crates.io):** cross-compile
  `relayflowd` per platform in CI, bundle binaries into the npm `flows`
  CLI/SDK + curl installer for self-host cells (see `../relay`
  `.github/workflows/publish.yml` — binary matrix shipped inside the npm
  package; no `cargo publish`). Reserve crate names on crates.io as a
  squatting hedge only. Needed before gate 2/3 consumers run on the kernel.
- **Persist review transcripts:** the review step's verdict currently leaves
  no evidence artifact (only the gating token). Capture review output to
  ops/ per tick until the kernel journal owns it.
- **Re-register cloud schedules from current drive.yaml** once a worker
  exists (registered bytes lag main), and delete stale schedule c8b6b7d0.
- **Customer harness is a named design partner** (`sales/harness` — authored on
  flows v2): its filed requirements rank gate work. First expected asks:
  `on()` triggers (gate 2), slack/notion helpers (gate 6), `f.human` channel
  delivery (covenant 3), memory scopes (gate 5).
- **PR titles from the pr step** leak the NEXT.md markdown header — use the
  work-package name.
- **The PR-shepherd flow (Garden component, gate 3):** when the Garden opens
  a PR, spawn a bounded-lifetime flow subscribed via relayfile to THAT PR
  only: `on(github.pr(N).review | .comment | .ci)` — each wake gets the
  original work-package requirements (ops/NEXT.md at PR time) + the new
  feedback in context, addresses findings from external reviewers (codex bot)
  and the relayflow review swarm (hoopsheet pattern), pushes fixes, replies,
  and closes itself at merge. The flow IS the PR's lifecycle. Khaliq,
  2026-08-27 — natural first real consumer of `on()` + relayfile PR trees.
