// The v2 authoring surface these regressions are written against.
//
// DECLARATION ONLY — no implementation exists yet. `@relayflows/surface` is
// what docs/SURFACE.md specifies and what gate-1 SDK work must produce. This
// file is deliberately the *narrow* slice the four regression pairs need, so it
// doubles as a requirements list: when the real surface exports these shapes,
// delete this file and the suite compiles against the SDK unchanged.
//
// Nothing here widens the kernel vocabulary. Three step verbs (run / llm /
// agent) + four resident verbs (on / human / dispatch / done); `f.cloud` is a
// helper namespace generated from a relayfile adapter (gate 6), and every verb
// on it compiles to a mount read/write or a wait (SURFACE.md §3).

declare module "@relayflows/surface" {
  /** A step result with its postfix verification gate (SURFACE.md §2 law 2). */
  export interface Step<T> extends PromiseLike<T> {
    /** Fails the step with `gate_failed` when the predicate is false. */
    gate(predicate: (value: T) => boolean, because?: string): Step<T>;
  }

  /** Optional header — escalation only; the empty header is the common case. */
  export interface FlowHeader {
    identity?: string;
    memory?: { script?: boolean; agent?: boolean };
    budget?: string;
    tools?: { relayfile?: string[]; mcp?: string[] };
    workspace?: string;
  }

  export interface AgentResult {
    summary: string;
    artifacts: string[];
  }

  export interface WorkerSummary {
    workerId: string;
    status: string;
    lastSeenAt: string | null;
  }

  export interface Heartbeat {
    workerId: string;
    status: string;
    lastSeenAt: string | null;
  }

  export interface EnrollmentReceipt {
    /** Mount path holding the plaintext token — never the token itself, so no
     *  secret is journaled (Appendix A rule 3: the mount write is the record). */
    tokenPath: string;
    expiresAt: string;
    registerCommand: string;
  }

  export interface ScheduleState {
    id: string;
    lastTriggerStatus: string | null;
    lastTriggeredRunId: string | null;
    lastTriggerError: string | null;
  }

  export interface JournalStep {
    id: string;
    type: "deterministic" | "llm" | "agent";
    completionReason: string | null;
  }

  export interface RunJournal {
    runId: string;
    steps: JournalStep[];
    completionReason: string | null;
  }

  /** Helper namespace generated from the AgentWorkforce cloud relayfile adapter. */
  export interface CloudHelper {
    workers: {
      mintEnrollmentToken(input: {
        workspaceId: string;
        name: string;
        /** Credential scope to act under — `<mount>/principals/<as>` (gate 8). */
        as: string;
      }): Step<EnrollmentReceipt>;
      list(input: { workspaceId: string; as: string }): Step<{
        online: WorkerSummary[];
        all: WorkerSummary[];
      }>;
      heartbeat(input: { workerId: string; as: string }): Step<Heartbeat>;
      /** Compiles to a durable wait — a legal plugin compile target (SURFACE.md §3). */
      awaitHeartbeat(input: { workerId: string; as: string; within: string }): Step<Heartbeat>;
    };
    schedules: {
      create(input: {
        workspaceId: string;
        workflow: string;
        cron: string;
        name: string;
        as: string;
      }): Step<{ id: string }>;
      /** Force one sweep tick for this schedule. */
      fire(input: { scheduleId: string; as: string }): Step<{ accepted: boolean }>;
      get(input: { scheduleId: string; as: string }): Step<ScheduleState>;
      remove(input: { scheduleId: string; as: string }): Step<{ deleted: boolean }>;
    };
    runs: {
      journal(input: { runId: string; as: string }): Step<RunJournal>;
    };
  }

  /** The flow context: three step verbs, four resident verbs, helpers. */
  export interface Ctx {
    run(command: string): Step<string>;
    llm(strings: TemplateStringsArray, ...values: unknown[]): Step<string>;
    agent(name: string, options: { task: string; workspace?: string }): Step<AgentResult>;
    human(question: string, options: { to: string }): Promise<boolean>;
    dispatch<T>(flow: string, input: unknown): Promise<T>;
    done(reason: string): void;
    cloud: CloudHelper;
  }

  export interface FlowHandle {
    readonly name: string;
  }

  export function flow(name: string, body: (f: Ctx) => Promise<void>): FlowHandle;
  export function flow(
    name: string,
    header: FlowHeader,
    body: (f: Ctx) => Promise<void>,
  ): FlowHandle;
}
