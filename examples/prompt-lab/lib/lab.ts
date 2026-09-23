// The flow's side of the lab store: every read and write is one journaled
// `f.run` step. Author code never touches the filesystem directly.
import type { Ctx } from "@relayflows/surface";
import type { Snapshot } from "./types.ts";

const STORE = new URL("../store.ts", import.meta.url).pathname;

/** User text never reaches a shell unquoted. */
export const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

/**
 * Fail the run with a journaled reason: a deterministic step that exits 1.
 *
 * Used instead of a predicate `.gate()` because relayflows 2.0.29 cannot
 * resume past one: the recorded verdict comes back from the journal with its
 * keys re-ordered, the lowered `<step>.gate` spec no longer matches, and the
 * resume is refused as run_admission_conflict
 * (evidence/runtime-findings/00-job1-attempt4-predicate-gate-resume-conflict.txt).
 * Fixed in flows#558; return to `.gate()` once a release carries it.
 */
export async function failStep(f: Ctx, reason: string): Promise<never> {
  await f.run(`echo ${shellWord(reason)} >&2; exit 1`);
  throw new Error(reason); // unreachable: the step above fails the run
}

export interface Lab {
  snapshot(): Promise<Snapshot>;
  read<T>(rel: string, check: (value: T) => string | null): Promise<T>;
  writeNew(rel: string, value: unknown): Promise<{ written: boolean }>;
  record(store: "targets" | "gold", entries: Record<string, unknown>): Promise<unknown>;
  draft(questionId: string, prompt: string): Promise<{ promptId: string }>;
  /** Compare-and-swap on the live prompt the caller read (null: none). */
  publish(questionId: string, promptId: string, expectedLive: string | null): Promise<{ previous: string | null }>;
  enqueue(queue: "issues" | "patient-briefs", item: { id: string }): Promise<{ added: boolean }>;
  closeIssue(id: string): Promise<unknown>;
  lockPatient(patient: unknown, briefId?: string): Promise<{ shelfPath: string }>;
}

export function lab(f: Ctx, dir: string): Lab {
  const store = async (...args: string[]): Promise<any> =>
    JSON.parse(await f.run(`node --no-warnings --experimental-strip-types ${shellWord(STORE)} ${[dir, ...args].map(shellWord).join(" ")}`));
  return {
    snapshot: () => store("snapshot"),
    async read<T>(rel: string, check: (value: T) => string | null) {
      const value = JSON.parse(await f.run(`node --no-warnings --experimental-strip-types ${shellWord(STORE)} ${shellWord(dir)} read ${shellWord(rel)}`)) as T;
      const why = check(value);
      // A reviewer's broken edit fails the run instead of persisting a half-valid value.
      if (why) await failStep(f, `${rel}: ${why}`);
      return value;
    },
    writeNew: (rel, value) => store("write-new", rel, b64(value)),
    record: (s, entries) => store("record", s, b64(entries)),
    draft: (q, prompt) => store("draft", q, b64(prompt)),
    publish: (q, id, expected) => store("publish", q, id, expected ?? "-"),
    enqueue: (queue, item) => store("enqueue", queue, b64(item)),
    closeIssue: (id) => store("close-issue", id),
    lockPatient: (patient, briefId) => store("lock-patient", b64(patient), ...(briefId ? [briefId] : [])),
  };
}
