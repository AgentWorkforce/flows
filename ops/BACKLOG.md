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
