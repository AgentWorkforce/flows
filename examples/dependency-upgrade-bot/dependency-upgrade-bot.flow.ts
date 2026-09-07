// dependency-upgrade-bot — a v2 relayflow (docs/SURFACE.md dialect).
//
// A deterministic check flags an out-of-date dependency, an agent performs
// the upgrade in its own sandboxed workspace, and a SECOND agent — in a
// SEPARATE sandbox, with no access to the upgrader's workspace — verifies
// the whole application still works using computer use (driving the app the
// way a person would, not just re-running unit tests) before a PR is ever
// opened. The upgrader's own claim of success is worth nothing on its own;
// only the independent verifier's passing artifact opens the PR.
//
// STATUS: typechecks against the real `@relayflows/surface` package (see
// ../tsconfig.json / `npm --prefix packages/surface run typecheck:examples`)
// but does not run yet — `f.agent` parks without an attached worker, and
// there is no kernel-enforced workspace isolation yet (RFC-0001 Appendix A
// rule 1 / gate 8), so today the "separate sandbox" boundary between
// upgrader and verifier is declared, not enforced.

import { flow } from "@relayflows/surface";

export default flow(
  "dependency-upgrade-bot",
  { budget: "$4/run" },
  async (f) => {
    const outdated = await f
      .run("npm outdated --json 2>/dev/null || true")
      .gate(
        (out) => out.trim().length > 0 && out.trim() !== "{}",
        "nothing is out of date — no upgrade to attempt",
      );

    const upgrade = await f
      .agent("upgrader", {
        task:
          `One or more dependencies are out of date:\n${outdated}\n\n` +
          `Upgrade them, run the test suite, and fix anything the upgrade breaks. ` +
          `Write a one-paragraph summary of what changed to sandbox/upgrade/CHANGES.md.`,
        workspace: "sandbox/upgrade: readwrite",
      })
      .gate(
        (r) => r.artifacts.includes("sandbox/upgrade/CHANGES.md"),
        "the upgrader must document what it changed",
      );

    // A second agent, in a workspace the upgrader never touches, has to
    // independently verify the result before anything ships. It gates on a
    // file it wrote after actually driving the app, not on the upgrader's
    // own summary.
    const verification = await f
      .agent("verifier", {
        task:
          `Read sandbox/upgrade/CHANGES.md. In this sandbox, install the ` +
          `upgraded dependencies and boot the application. Using computer use, ` +
          `click through the application's key flows the way a real user would. ` +
          `If — and only if — everything works, write sandbox/verify/PASSED. ` +
          `Otherwise write sandbox/verify/FAILED with exactly what broke.`,
        workspace: "sandbox/verify: readwrite",
      })
      .gate(
        (r) => r.artifacts.includes("sandbox/verify/PASSED"),
        "the upgrade only ships once an independent sandbox verifies it end to end",
      );

    const pr = await f
      .run(
        'gh pr create --title "Dependency upgrade (verified)" ' +
          "--body-file sandbox/verify/PASSED",
      )
      .gate(
        (out) => /https:\/\/github\.com\/.+\/pull\/\d+/.test(out),
        "must actually open a PR, not just report success",
      );

    f.done("success");
  },
);
