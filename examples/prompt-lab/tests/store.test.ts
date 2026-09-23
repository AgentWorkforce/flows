import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
