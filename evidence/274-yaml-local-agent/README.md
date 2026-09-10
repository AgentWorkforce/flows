# YAML local agent verification

Base: `3ae6c24e` (`origin/main`). No kernel or daemon protocol changes.

- [TypeScript, build, and seven YAML regression tests](checks.txt): literal commands and output. The regression covers step, named-agent, flow, and project CLI selection; reads `run.get` to assert `greet.state === "done"`; verifies the journaled instruction and model; and checks missing-worker, CLI failure, and unsupported workspace behavior.
- [Isolated daemon build](test-prep.txt): `npm run test:prep` with the installed Rust toolchain on `PATH`.
- [Final full SDK suite with the isolated daemon](sdk-suite-final.txt): literal command and output, including optional test skips.
- [Original Codex YAML repro](real-codex.txt): a fresh directory outside a repository, an empty project config, the YAML spec, and the built CLI's report from the installed authenticated Codex CLI.

The initial [full SDK suite](sdk-suite.txt) and targeted checks used the existing `flows-lead` daemon binary while the host lacked space for a separate Rust build. Once space became available, the isolated build completed and the suite was repeated against that binary. Temporary run directories in the captured output were removed after the checks.

The first [suite against the isolated daemon](sdk-suite-isolated.txt) failed the existing `preflights before journaling and names an unreachable socket` test: its directory snapshot caught `connection.json.tmp.9958` before the daemon renamed it to `connection.json`. The YAML tests passed. The final suite reruns the unchanged tests with one Vitest worker to reduce startup contention.
