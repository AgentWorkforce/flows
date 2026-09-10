// Reconstruct final trees from captured patches; never rerun a model or
// pretend reconstructed commits are the historical commit objects.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EXAMPLE_ROOT, materializeTrialRepo, runChecks } from "./trial-runtime.ts";

const root = join(EXAMPLE_ROOT, "runs");
let count = 0;
for (const arm of (await readdir(root)).sort()) {
  for (const id of (await readdir(join(root, arm))).sort()) {
    const evidence = join(root, arm, id);
    const verdict = JSON.parse(await readFile(join(evidence, "verdict.json"), "utf8"));
    const parent = await mkdtemp(join(tmpdir(), "compliance-audit-"));
    const repo = join(parent, "repo");
    try {
      await materializeTrialRepo(repo, {withSkill: arm.startsWith("agent-plus-skill")});
      const git = (...args: string[]) => execFileSync("git", args, {cwd:repo, encoding:"utf8"});
      git("apply", "--index", join(evidence, "diff.patch"));
      // Recreate subjects in their original order. The first reconstructed
      // commit contains the final patch; intermediate trees are unavailable.
      const subjects = (await readFile(join(evidence, "commits.txt"), "utf8"))
        .trim().split("\n").map(line => line.slice(line.indexOf(" ") + 1)).reverse();
      for (const subject of subjects) git("commit", "--allow-empty", "-qm", subject);
      const checks = await runChecks(repo);
      assert.deepEqual(checks.map(c => [c.name,c.pass]), verdict.checks.map((c: {name:string;pass:boolean}) => [c.name,c.pass]));
      let skillCalls = 0;
      for (const file of await readdir(evidence)) {
        if (!/^(transcript|attempt-\d+-implementer)\.txt$/.test(file)) continue;
        for (const line of (await readFile(join(evidence,file),"utf8")).split("\n")) {
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          for (const item of event.message?.content ?? []) {
            if (item.type === "tool_use" && item.name === "Skill") skillCalls++;
          }
        }
      }
      console.log(`${arm}/${id}: final checks match; Skill calls=${skillCalls}; ${checks.filter(c=>!c.pass).map(c=>c.name).join(",") || "all pass"}`);
      count++;
    } finally { await rm(parent, {recursive:true, force:true}); }
  }
}
console.log(`Audited ${count} captured final trees. Intermediate attempts and test-first ordering were not reconstructed.`);
