import type { Step } from "./step.js";
import type {
  CompletionReason,
  RunCompletionReason,
} from "./completion.js";

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
  completionReason: CompletionReason | null;
}

export interface RunJournal {
  runId: string;
  steps: JournalStep[];
  completionReason: RunCompletionReason | null;
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

/** Delivery-only request accepted by the host-owned native Babysitter adapter. */
export interface CloudBabysitterTurnDelivery {
  readonly deliveryId: string;
  readonly provider: 'github';
  readonly eventType: string;
  readonly pullRequest: {
    readonly owner: string;
    readonly repository: string;
    readonly number: number;
  };
}

/** The only successful native-turn outcomes; refusals reject the call. */
export interface CloudBabysitterTurnReceipt {
  readonly receiptId: string;
  readonly status: 'queued' | 'duplicate';
}

export interface CloudBabysitterTurnCapability {
  queue(request: { readonly delivery: CloudBabysitterTurnDelivery }): PromiseLike<CloudBabysitterTurnReceipt>;
}

/** Capability ports are injected by a host runtime, never constructed by authored input. */
export interface CloudCapabilities {
  readonly babysitterTurn?: CloudBabysitterTurnCapability;
}
