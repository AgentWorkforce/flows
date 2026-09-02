import type { Step } from "./context.js";

export interface WorkerSummary {
  workerId: string;
  status: string;
  lastSeenAt: string | null;
}

export interface Heartbeat extends WorkerSummary {}

export interface EnrollmentReceipt {
  /** Mount path for the token. The credential itself never enters the journal. */
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

/** AgentWorkforce Cloud helper contract generated from its relayfile adapter. */
export interface CloudHelper {
  workers: {
    mintEnrollmentToken(input: {
      workspaceId: string;
      name: string;
      /** Principal resolved at `<mount>/principals/<as>`. */
      as: string;
    }): Step<EnrollmentReceipt>;
    list(input: { workspaceId: string; as: string }): Step<{
      online: WorkerSummary[];
      all: WorkerSummary[];
    }>;
    heartbeat(input: { workerId: string; as: string }): Step<Heartbeat>;
    awaitHeartbeat(input: {
      workerId: string;
      as: string;
      within: string;
    }): Step<Heartbeat>;
  };
  schedules: {
    create(input: {
      workspaceId: string;
      workflow: string;
      cron: string;
      name: string;
      as: string;
    }): Step<{ id: string }>;
    fire(input: { scheduleId: string; as: string }): Step<{ accepted: boolean }>;
    get(input: { scheduleId: string; as: string }): Step<ScheduleState>;
    remove(input: { scheduleId: string; as: string }): Step<{ deleted: boolean }>;
  };
  runs: {
    journal(input: { runId: string; as: string }): Step<RunJournal>;
  };
}
