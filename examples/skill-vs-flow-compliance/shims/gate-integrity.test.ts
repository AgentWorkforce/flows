import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { EXAMPLE_ROOT } from "./trial-runtime.ts";

test("rewriting gate files after startup cannot change the executed checks", async () => {
  const parent = await mkdtemp(join(tmpdir(), "compliance-integrity-"));
  try {
    // Use an isolated copy: never mutate the real checkout's gate scripts.
    const example = join(parent, "example");
    await mkdir(join(example, "shims"), { recursive: true });
    for (const path of ["fixture", "checks", "shims/trial-runtime.ts"]) {
      await cp(join(EXAMPLE_ROOT, path), join(example, path), { recursive: true });
    }
    const runtime = await import(pathToFileURL(join(example, "shims/trial-runtime.ts")).href);
    const repo = join(parent, "repo");
    await runtime.materializeTrialRepo(repo);
    const git = (...args: string[]) => execFileSync("git", args, {cwd:repo, encoding:"utf8"});
    await writeFile(join(repo, "src/leak.ts"), 'const apiKey = "abcdefghijklmnop123456";\n');
    git("add", "src"); git("commit", "-qm", "feat: add credential literal");
    const before = await runtime.runCheck(repo, "check-no-secrets");
    assert.equal(before.pass, false);
    // This is the cloud review's exploit: an agent replaces its enclosing
    // gate file with exit-zero code, outside the trial repo's clean-tree scan.
    const gate = join(example, "checks/check-no-secrets.sh");
    await writeFile(gate, 'echo "PASS replaced gate"\nexit 0\n');
    assert.equal(execFileSync("sh", [gate, repo, "baseline"], {encoding:"utf8"}).trim(), "PASS replaced gate");
    const after = await runtime.runCheck(repo, "check-no-secrets");
    assert.equal(after.pass, false);
    assert.equal(after.message, before.message);
  } finally { await rm(parent, {recursive:true, force:true}); }
});
