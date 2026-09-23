import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const STORE = new URL("../store.ts", import.meta.url).pathname;
const FIXTURES = new URL("../fixtures", import.meta.url).pathname;
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

function seeded(): { lab: string; store: (...a: string[]) => { status: number | null; out: any; err: string } } {
  const lab = join(mkdtempSync(join(tmpdir(), "prompt-lab-")), "lab");
  const store = (...args: string[]) => {
    const r = spawnSync("node", ["--no-warnings", "--experimental-strip-types", STORE, lab, ...args], { encoding: "utf8" });
    return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
  };
  assert.equal(store("seed", FIXTURES).status, 0);
  return { lab, store };
}

test("seed refuses to overwrite an existing lab", () => {
  const { store } = seeded();
  const again = store("seed", FIXTURES);
  assert.equal(again.status, 1);
  assert.match(again.err, /already a lab/);
});

test("snapshot reads the whole lab", () => {
  const { store } = seeded();
  const s = store("snapshot").out;
  assert.deepEqual(s.shelf.map((p: { id: string }) => p.id), ["jordan", "pat", "riley"]);
  assert.equal(s.bank.questions["wound-status"].livePromptId, "p-wound-status-v1");
  assert.deepEqual(s.gold, {});
});

test("write-new never clobbers a reviewer's edit (a retried step converges)", () => {
  const { lab, store } = seeded();
  assert.equal(store("write-new", "work/g.json", b64([1])).out.written, true);
  writeFileSync(join(lab, "work/g.json"), "[\"edited\"]");
  assert.equal(store("write-new", "work/g.json", b64([1])).out.written, false);
  assert.equal(readFileSync(join(lab, "work/g.json"), "utf8"), "[\"edited\"]");
  assert.match(store("write-new", "../escape.json", b64(1)).err, /escapes the lab/);
});

test("draft is content-addressed and publish is Done = live, both idempotent", () => {
  const { store } = seeded();
  const a = store("draft", "wound-status", b64("new text")).out;
  assert.deepEqual(store("draft", "wound-status", b64("new text")).out, a);
  assert.equal(store("snapshot").out.bank.questions["wound-status"].livePromptId, "p-wound-status-v1"); // a draft is not live
  assert.equal(store("publish", "wound-status", a.promptId).out.previous, "p-wound-status-v1");
  assert.equal(store("publish", "wound-status", a.promptId).out.previous, null);
  const q = store("snapshot").out.bank.questions["wound-status"];
  assert.equal(q.livePromptId, a.promptId);
  assert.equal(q.draftPromptId, null);
  assert.equal(store("publish", "wound-status", "p-nope").status, 1);
});

test("enqueue is keyed by id; lock-patient freezes a chart and closes its brief", () => {
  const { store } = seeded();
  const brief = { id: "gap-x", questionId: "ostomy-supplies", brief: "b", from: "planner", status: "queued" };
  assert.equal(store("enqueue", "patient-briefs", b64(brief)).out.added, true);
  assert.equal(store("enqueue", "patient-briefs", b64(brief)).out.added, false);
  const p = { id: "sam", label: "Sam", ageBand: "65-74", visitType: "soc", referral: "r", notes: "n" };
  assert.equal(store("lock-patient", b64(p), "gap-x").status, 0);
  assert.equal(store("lock-patient", b64(p), "gap-x").status, 0); // same chart: converges
  assert.match(store("lock-patient", b64({ ...p, notes: "other" })).err, /different sam/);
  const s = store("snapshot").out;
  assert.equal(s.shelf.find((x: { id: string }) => x.id === "sam").locked, true);
  assert.equal(s.patientBriefs[0].status, "locked");
});

test("concurrent store processes never lose an update (the lab lock serializes read-modify-write)", async () => {
  const { lab, store } = seeded();
  const run = (...args: string[]) => new Promise<number | null>((resolve) => {
    spawn("node", ["--no-warnings", "--experimental-strip-types", STORE, lab, ...args]).on("close", resolve);
  });
  const texts = Array.from({ length: 8 }, (_, i) => `prompt text number ${i}`);
  const codes = await Promise.all([
    ...texts.map((t) => run("draft", "mood", b64(t))),
    ...texts.map((_, i) => run("enqueue", "issues", b64({ id: `i-${i}` }))),
  ]);
  assert.deepEqual(codes, Array(16).fill(0));
  const s = store("snapshot").out;
  for (const t of texts) assert.ok(Object.values(s.bank.prompts).includes(t), `lost draft: ${t}`);
  assert.equal(s.issues.length, 8);
  assert.equal(existsSync(join(lab, ".lock")), false);
});

test("a failing mutating verb releases the lock", () => {
  const { lab, store } = seeded();
  assert.equal(store("publish", "mood", "p-nope").status, 1);
  assert.equal(existsSync(join(lab, ".lock")), false);
  assert.equal(store("draft", "mood", b64("still writable")).status, 0);
});

test("the output limit counts UTF-8 bytes, not characters", () => {
  const { store } = seeded();
  // 25k characters (é is 2 bytes, 中 is 3): about 62.5 KB of UTF-8, under the limit in UTF-16 units.
  assert.equal(store("write-new", "work/big.json", b64("é中".repeat(12_500))).status, 0);
  const r = store("read", "work/big.json");
  assert.equal(r.status, 1);
  assert.match(r.err, /bytes, over the 61440-byte journal tail/);
});
