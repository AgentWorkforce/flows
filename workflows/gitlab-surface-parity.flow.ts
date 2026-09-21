// gitlab-surface-parity — close the `f.gitlab` read/list gap, a v2 relayflow.
//
// THE GAP. `Ctx` exposes a first-class `f.gitlab` helper and GitLab is listed
// as a supported provider with a generous trigger surface, but the helper can
// only post: its writeback catalog was `comments` and `discussions`, against
// GitHub's eight. A GitLab-sourced factory could not list issues, read an
// issue, or open a merge request through the helper, so authors reached for
// `glab` and split the integration across two mechanisms.
//
// WHY A DEPENDENCY BUMP IS THE FIX. `f.gitlab` is not hand-written. Its
// resources are generated (scripts/generate-helpers.mjs) from
// `WRITEBACK_PATH_CATALOG` in `@relayfile/adapter-core`, reached through the
// `@relayfile/relay-helpers` pin in packages/surface/package.json. Each
// catalog resource becomes `.read()` / `.list()` / `.write()` / `.path()`.
// So the helper was never the thing that was missing — the catalog was, and
// relayfile-adapters#282 filled it in:
//
//   adapter-core 0.5.24  gitlab: comments, discussions
//   adapter-core 0.6.0   gitlab: close-merge-request, comments, discussions,
//                                issues, merge, merge-requests, refs
//
// The helper gains `f.gitlab.issues.list()`, `.read()`, `.write()` and
// `f.gitlab["merge-requests"].write()` the moment this repository resolves a
// catalog that carries them. Nothing here should hand-write a GitLab method:
// that would be the second mechanism all over again.
//
// THE UPSTREAM PRECONDITION. `relay-helpers` must itself depend on the newer
// core — npm will never resolve `^0.5.15` to `0.6.0`. That was the blocker
// when this flow was written (published relay-helpers 0.4.11 still pointed at
// `^0.5.15`); relay-helpers 0.4.12 closed it. The flow still probes the
// registry rather than trusting this comment, so if a future core bump lands
// out of reach again it reports the exact dependency edge and declines
// instead of inventing a local fix.
//
// The pin this repository now carries (relay-helpers 0.4.12) was applied by
// hand in the same change that added this file, so a first run here is a
// no-op that declines at the "already resolved" branch. It earns its keep on
// the NEXT catalog bump.
//
// Local: flows run workflows/gitlab-surface-parity.flow.ts --local-agent
// Cloud: deploy as a manual/scheduled listener on AgentWorkforce/flows.

import { flow } from "@relayflows/surface";

const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export interface GitlabSurfaceParityInput {
  /**
   * Skip the registry probe and use this exact `@relayfile/relay-helpers`
   * version. The probe still verifies its catalog before anything is written,
   * so a wrong pin fails loudly rather than landing a no-op bump.
   */
  relayHelpersVersion?: string;
  /** Branch to push. Defaults to a fixed name so re-runs update one PR. */
  branch?: string;
}

// The resources #282 added. The flow asserts the generated helper exposes
// every one of them with read/list/write — the parity claim this PR makes is
// checked against the built surface, not against the changelog.
const REQUIRED = ["issues", "merge-requests", "refs", "merge", "close-merge-request"] as const;
const PROBE = "parity/probe.json";
const REPORT = "parity/report.md";
const SURFACE_PKG = "packages/surface/package.json";
const CLI = "claude";

/** A published version string, as npm would print it. Interpolated into a shell command. */
function validVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value);
}

export default flow<GitlabSurfaceParityInput>(
  "gitlab-surface-parity",
  { budget: "$2/run" },
  async (f, input) => {
    const branch = input.branch ?? "feat/gitlab-surface-parity";
    if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/u.test(branch)) {
      throw new Error(`gitlab-surface-parity: refusing an unsafe branch name: ${JSON.stringify(branch)}`);
    }
    if (input.relayHelpersVersion !== undefined && !validVersion(input.relayHelpersVersion)) {
      throw new Error(
        `gitlab-surface-parity: relayHelpersVersion is not a semver: ${JSON.stringify(input.relayHelpersVersion)}`,
      );
    }

    await f.run("rm -rf parity && mkdir -p parity");

    // STEP 1 — probe the registry for a relay-helpers whose TRANSITIVE
    // adapter-core actually carries the GitLab resources. This installs each
    // candidate into a throwaway prefix and READS the catalog; a version range
    // in a manifest is not evidence that the resource exists, and this is the
    // one fact the whole flow rests on.
    const candidate = input.relayHelpersVersion ? shellWord(input.relayHelpersVersion) : "";
    const probe = await f.run(
      `cd parity && mkdir -p probe && cd probe && printf '{"name":"probe","private":true}' > package.json && `
        + `versions=$(${candidate ? `printf '%s' ${candidate}` : `npm view @relayfile/relay-helpers versions --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(v.slice(-8).reverse().join(" "))})'`}) && `
        + `for v in $versions; do `
        + `npm i --no-audit --no-fund --silent "@relayfile/relay-helpers@$v" >/dev/null 2>&1 || continue; `
        + `found=$(node --input-type=module -e '`
        + `const m = await import("@relayfile/adapter-core/writeback-paths");`
        + `const r = Object.keys(m.WRITEBACK_PATH_CATALOG.gitlab ?? {});`
        + `process.stdout.write(JSON.stringify(r));' 2>/dev/null) || continue; `
        + `case "$found" in *'"issues"'*) `
        + `core=$(node -p "require('@relayfile/adapter-core/package.json').version" 2>/dev/null); `
        + `printf '{"version":"%s","core":"%s","resources":%s}' "$v" "$core" "$found" > ../../${PROBE}; break;; esac; `
        + `done; cat ../../${PROBE} 2>/dev/null || printf '{}'`,
      { timeout: "10m" },
    );

    // STEP 2 — no usable version yet: the blocker is upstream. Report it
    // precisely (which package, which dependency edge) and decline. A flow
    // that "fixed" this locally would be pinning a catalog nobody published.
    if (!probe.includes('"version"')) {
      await f.run(
        `printf '%s\\n' '# gitlab-surface-parity: blocked upstream' '' \\
          'No published @relayfile/relay-helpers resolves an @relayfile/adapter-core whose' \\
          'WRITEBACK_PATH_CATALOG.gitlab contains "issues" (probed the 8 newest versions).' '' \\
          'relayfile-adapters#282 added the GitLab writeback resources and shipped them in' \\
          'adapter-core 0.6.0, but relay-helpers still declares adapter-core ^0.5.x, and npm' \\
          'will never resolve that range to 0.6.0. The gitlab helper stays post-only until' \\
          'relay-helpers is republished against ^0.6.0 from the relayfile-adapters repo.' '' \\
          'Fix upstream first, then re-run this flow (or pass relayHelpersVersion).' > ${REPORT}`,
      );
      return f.done("declined");
    }

    // STEP 3 — bump the pin, reinstall, regenerate. The pin is exact in this
    // repository (packages/surface/package.json), so it is rewritten from the
    // probe's own answer rather than from a range.
    await f.run(
      `node -e '`
        + `const fs=require("fs"); const probe=JSON.parse(fs.readFileSync("${PROBE}","utf8"));`
        + `const p="${SURFACE_PKG}"; const m=JSON.parse(fs.readFileSync(p,"utf8"));`
        + `const cur=m.dependencies["@relayfile/relay-helpers"];`
        + `if(cur===undefined) throw new Error("no @relayfile/relay-helpers dependency in "+p);`
        + `m.dependencies["@relayfile/relay-helpers"]=probe.version;`
        + `fs.writeFileSync(p, JSON.stringify(m,null,2)+"\\n");`
        + `console.log(cur+" -> "+probe.version);'`,
      { timeout: "1m" },
    );
    await f.run("npm install --prefix packages/surface --no-audit --no-fund", { timeout: "15m" });
    await f.run("npm run gen --prefix packages/surface", { timeout: "5m" });

    // STEP 4 — the parity gate. Import the BUILT surface and assert every
    // resource #282 added is reachable with the four accessors. This is what
    // makes the PR's claim falsifiable: if the generator did not pick the
    // resources up, the flow fails here instead of opening a green-looking PR.
    await f.run("npm run build --prefix packages/surface", { timeout: "10m" });
    await f.run(
      `node --input-type=module -e '`
        + `const { createGitlabHelper } = await import("./packages/surface/dist/helpers/gitlab.js");`
        + `const calls = [];`
        + `const helper = createGitlabHelper((effect) => { calls.push(effect); return Promise.resolve(undefined); });`
        + `const required = ${JSON.stringify([...REQUIRED])};`
        + `const missing = required.filter((r) => helper[r] === undefined);`
        + `if (missing.length > 0) throw new Error("the gitlab helper is missing: " + missing.join(", "));`
        + `const partial = required.filter((r) => ["read","list","write","path"].some((m) => typeof helper[r][m] !== "function"));`
        + `if (partial.length > 0) throw new Error("gitlab helper resources missing read/list/write/path: " + partial.join(", "));`
        + `console.log("gitlab helper parity OK: " + required.join(", "));'`,
      { timeout: "5m" },
    );

    // STEP 5 — the repository's own tests must still pass. A generated file
    // has a snapshot test here (helpers.snapshot.test.ts); regenerating
    // without updating it is exactly the kind of drift this gate exists for.
    await f.run("npm test --prefix packages/surface", { timeout: "20m" });

    // STEP 6 — docs. The generated helper is the source of truth, so the only
    // hand-written thing left is every place that told an author GitLab could
    // not do this. An agent (not a sed) does it because the claims are prose
    // and live in several files.
    await f
      .agent("docs", {
        cli: CLI,
        task:
          `@relayfile/relay-helpers was just bumped in ${SURFACE_PKG} and packages/surface/src/helpers/gitlab.ts `
          + `was regenerated, so the gitlab helper now exposes ${REQUIRED.join(", ")} with read/list/write/path (previously `
          + `only comments and discussions). Update the documentation and examples that still say or imply GitLab `
          + `is post-only or second-class — check docs/SURFACE.md, docs/CLOUD.md, README.md, examples/README.md and `
          + `any provider/capability table. Only change claims that are now false; do not restate the changelog, do `
          + `not touch generated files (packages/surface/src/helpers/*.ts), and do not edit code. Then write ${REPORT} `
          + `as the pull request body: what the gap was, that the fix is a catalog bump rather than a hand-written `
          + `GitLab client, the before/after resource lists (read them from ${PROBE}), the parity assertion that now `
          + `guards it, and every doc file you changed. If no doc made a false claim, say so in ${REPORT} explicitly.`,
      })
      .gate({ type: "artifact_exists", path: REPORT });

    // STEP 7 — publish. One branch, force-pushed, so a re-run updates the
    // same PR instead of opening a second one. `gh` uses the sandbox's
    // GH_TOKEN, the same credential git has there (see pr-review.flow.ts:
    // the relayfile GitHub mount is not attached to authored Cloud runs).
    const changed = await f.run("git status --porcelain | head -c 4000");
    if (changed.trim().length === 0) {
      await f.run(`printf '%s\\n' 'No change: the pin already resolved a catalog with the GitLab resources.' >> ${REPORT}`);
      return f.done("declined");
    }
    await f.run(
      `git checkout -B ${shellWord(branch)} && `
        + `git add -A ':(exclude)parity' && `
        + `git -c user.name='relayflow' -c user.email='flows@agent-relay.com' commit -m `
        + shellWord(
          "feat(surface): give the gitlab helper its issue and merge-request surface\n\n"
            + "Bumps @relayfile/relay-helpers so the generated helper picks up the\n"
            + "GitLab writeback resources added in relayfile-adapters#282. No GitLab\n"
            + "method is hand-written: the helper is generated from the adapter-core\n"
            + "writeback catalog, and the catalog is what was missing.",
        )
        + ` && git push --force-with-lease -u origin ${shellWord(branch)}`,
      { timeout: "5m" },
    );
    await f.run(
      `gh pr create --repo AgentWorkforce/flows --base main --head ${shellWord(branch)} `
        + `--title 'feat(surface): give the gitlab helper its issue and merge-request surface' --body-file ${REPORT} `
        + `|| gh pr edit --repo AgentWorkforce/flows ${shellWord(branch)} --body-file ${REPORT}`,
      { timeout: "5m" },
    );
    f.done("success");
  },
);
