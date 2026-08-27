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
