// The lab store: the one writer of a Prompt Lab state directory. It stands in
// for Apricot's Bank (bank.json: global prompts, livePromptId) plus Prompt
// Lab's own records (briefs, targets, gold, queues, work files).
//
// Flow steps call it through `f.run`, so every read and write is a journaled
// deterministic step. Every verb is idempotent: a retried step converges on
// the same state and prints the same result. Values arrive base64-encoded JSON
// so no user text is ever parsed by a shell.
//
//   node store.ts <lab> seed <fixtures>
//   node store.ts <lab> snapshot | read <rel>
//   node store.ts <lab> write-new <rel> <b64>        (never clobbers a reviewer's edit)
//   node store.ts <lab> record <targets|gold> <b64 {key: Output}>
//   node store.ts <lab> draft <questionId> <b64 text>
//   node store.ts <lab> publish <questionId> <promptId>
//   node store.ts <lab> enqueue <issues|patient-briefs> <b64 item>
//   node store.ts <lab> close-issue <issueId>
//   node store.ts <lab> lock-patient <b64 patient> [briefId]
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Bank, Issue, Patient, PatientBrief, Snapshot } from "./lib/types.ts";

const OUTPUT_LIMIT = 60 * 1024; // the kernel journals a 64 KiB stdout tail; never let a read be cut.

const LOCK_WAIT_MS = 10_000;
/** Verbs that read-modify-write: serialized across processes, so concurrent runs never lose an update. */
const MUTATING = new Set(["write-new", "record", "draft", "publish", "enqueue", "close-issue", "lock-patient"]);

const [lab, verb, ...args] = process.argv.slice(2) as [string, string, ...string[]];

class StoreError extends Error {}
/** Throws, never exits: the lock is released on the way out. */
function fail(message: string): never {
  throw new StoreError(message);
}
function print(value: unknown): void {
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > OUTPUT_LIMIT) fail(`output is ${bytes} bytes, over the ${OUTPUT_LIMIT}-byte journal tail`);
  process.stdout.write(`${text}\n`);
}
/** An exclusive lab lock: mkdir is atomic, so one process holds it at a time. */
function withLock(work: () => void): void {
  const lock = join(lab, ".lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { mkdirSync(lock); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() > deadline) fail(`lab is locked (${lock}); remove it if no store process is running`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { work(); } finally { rmSync(lock, { recursive: true, force: true }); }
}
const path = (rel: string): string => {
  if (rel.startsWith("/") || rel.split("/").includes("..")) fail(`path escapes the lab: ${rel}`);
  return join(lab!, rel);
};
const decode = (b64: string | undefined): unknown => {
  if (!b64) fail("missing value");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
};
const readJson = <T>(rel: string, fallback: T): T =>
  existsSync(path(rel)) ? (JSON.parse(readFileSync(path(rel), "utf8")) as T) : fallback;
/** Atomic: a crash mid-write leaves the old file, never half a file. */
function writeJson(rel: string, value: unknown): void {
  const file = path(rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}
const listDir = (rel: string): string[] => (existsSync(path(rel)) ? readdirSync(path(rel)).sort() : []);

function run(): void {
switch (verb) {
  case "seed": {
    if (existsSync(join(lab, "bank.json"))) fail(`${lab} is already a lab; refusing to overwrite it`);
    cpSync(args[0] ?? fail("seed needs a fixtures dir"), lab, { recursive: true });
    print({ seeded: lab });
    break;
  }
  case "snapshot": {
    const snapshot: Snapshot = {
      bank: readJson("bank.json", { prompts: {}, questions: {} }),
      agencies: readJson("agencies.json", {}),
      guidelines: readFileSync(path("guidelines.md"), "utf8"),
      shelf: listDir("shelf").map((f) => readJson<Patient>(`shelf/${f}`, null as never)),
      briefs: Object.fromEntries(listDir("briefs").map((f) => [f.replace(/\.md$/, ""), readFileSync(path(`briefs/${f}`), "utf8")])),
      targets: readJson("targets.json", {}),
      gold: readJson("gold.json", {}),
      issues: readJson("queue/issues.json", []),
      patientBriefs: readJson("queue/patient-briefs.json", []),
    };
    print(snapshot);
    break;
  }
  case "read":
    print(readJson(args[0] ?? fail("read needs a path"), null));
    break;
  case "write-new": {
    const rel = args[0] ?? fail("write-new needs a path");
    const written = !existsSync(path(rel));
    if (written) writeJson(rel, decode(args[1]));
    print({ path: rel, written });
    break;
  }
  case "record": {
    const store = args[0];
    if (store !== "targets" && store !== "gold") fail("record takes targets or gold");
    const entries = decode(args[1]) as Record<string, unknown>;
    writeJson(`${store}.json`, { ...readJson(`${store}.json`, {}), ...entries });
    print({ store, recorded: Object.keys(entries).sort() });
    break;
  }
  case "draft": {
    const questionId = args[0] ?? fail("draft needs a question id");
    const text = decode(args[1]) as string;
    const bank = readJson<Bank>("bank.json", { prompts: {}, questions: {} });
    const question = bank.questions[questionId] ?? fail(`no question ${questionId}`);
    const promptId = `p-${questionId}-${createHash("sha256").update(text).digest("hex").slice(0, 8)}`;
    bank.prompts[promptId] = text;
    question.draftPromptId = promptId;
    writeJson("bank.json", bank);
    print({ questionId, promptId });
    break;
  }
  case "publish": {
    const [questionId, promptId] = args;
    const bank = readJson<Bank>("bank.json", { prompts: {}, questions: {} });
    const question = bank.questions[questionId ?? ""] ?? fail(`no question ${questionId}`);
    if (!promptId || !bank.prompts[promptId]) fail(`no prompt ${promptId}`);
    const previous = question.livePromptId;
    question.livePromptId = promptId;
    if (question.draftPromptId === promptId) question.draftPromptId = null;
    writeJson("bank.json", bank);
    print({ questionId, livePromptId: promptId, previous: previous === promptId ? null : previous });
    break;
  }
  case "enqueue": {
    const rel = args[0] === "issues" ? "queue/issues.json" : args[0] === "patient-briefs" ? "queue/patient-briefs.json" : fail("enqueue takes issues or patient-briefs");
    const item = decode(args[1]) as { id: string };
    const queue = readJson<{ id: string }[]>(rel, []);
    const added = !queue.some((q) => q.id === item.id);
    if (added) writeJson(rel, [...queue, item]);
    print({ queue: args[0], id: item.id, added });
    break;
  }
  case "close-issue": {
    const issues = readJson<Issue[]>("queue/issues.json", []);
    const issue = issues.find((i) => i.id === args[0]) ?? fail(`no issue ${args[0]}`);
    issue.status = "done";
    writeJson("queue/issues.json", issues);
    print({ issue: issue.id, status: issue.status });
    break;
  }
  case "lock-patient": {
    const patient: Patient = { ...(decode(args[0]) as Patient), locked: true, source: "invented" };
    const briefId = args[1];
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(patient.id)) fail(`bad patient id ${patient.id}`);
    const rel = `shelf/${patient.id}.json`;
    // Locked patients are frozen: a retry may re-lock the same chart, never replace one.
    const existing = readJson<Patient | null>(rel, null);
    if (existing && JSON.stringify(existing) !== JSON.stringify(patient)) fail(`shelf already has a different ${patient.id}`);
    if (!existing) writeJson(rel, patient);
    if (briefId) {
      const briefs = readJson<PatientBrief[]>("queue/patient-briefs.json", []);
      for (const b of briefs) if (b.id === briefId) b.status = "locked";
      writeJson("queue/patient-briefs.json", briefs);
    }
    print({ patient: patient.id, locked: true, shelfPath: rel });
    break;
  }
  default:
    fail(`unknown verb ${verb}`);
}
}

try {
  if (!lab || !verb) fail("usage: store.ts <lab> <verb> [args]");
  if (MUTATING.has(verb)) withLock(run); else run();
} catch (error) {
  process.stderr.write(`store: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
