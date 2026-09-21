import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { github, providerEventTypes } from "../src/triggers/index.js";

const babysitterActions = [
  "pull_request.ready_for_review",
  "pull_request.labeled",
  "pull_request.unlabeled",
] as const;

describe("generated GitHub trigger vocabulary", () => {
  it("offers check_run and issue_comment with an action filter, like pull_request", () => {
    // The adapter's own mapping supersedes the core fallback, so the vocabulary
    // is a superset of the six fallback events; those six must always remain.
    expect([...providerEventTypes.github]).toEqual(expect.arrayContaining([
      "check_run", "issue_comment", "issues", "pull_request", "pull_request_review", "push",
    ]));
    expect(github.check_run("completed").filter).toEqual({ provider: "github", type: "check_run", payload: { action: "completed" } });
    expect(github.issue_comment("created").filter).toEqual({ provider: "github", type: "issue_comment", payload: { action: "created" } });
    expect(github.issue_comment().filter).toEqual({ provider: "github", type: "issue_comment" });
    expect(() => github.check_run("")).toThrow(TypeError);
  });

  it("ships every pull-request action Babysitter declares in the source and built package", () => {
    expect([...providerEventTypes.github]).toEqual(expect.arrayContaining([...babysitterActions]));
    expect(github.pull_request_ready_for_review().filter).toEqual({ provider: "github", type: "pull_request.ready_for_review" });
    expect(github.pull_request_labeled().filter).toEqual({ provider: "github", type: "pull_request.labeled" });
    expect(github.pull_request_unlabeled().filter).toEqual({ provider: "github", type: "pull_request.unlabeled" });

    // @relayflows/surface publishes dist/ (package.json "files"). The package
    // test builds before Vitest, so this pins the artifact consumers receive,
    // not only the TypeScript generator input.
    const built = readFileSync(new URL("../dist/triggers/index.js", import.meta.url), "utf8");
    for (const event of babysitterActions) expect(built).toContain(JSON.stringify(event));
  });
});
