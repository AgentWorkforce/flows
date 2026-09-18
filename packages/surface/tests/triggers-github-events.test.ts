import { describe, expect, it } from "vitest";
import { github, providerEventTypes } from "../src/triggers/index.js";

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
});
