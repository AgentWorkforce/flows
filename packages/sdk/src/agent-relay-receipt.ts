import { canonicalize } from "./canonical.js";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export interface RelayTaskExecution {
  execution_id: string;
  run_id: string;
  step_id: string;
  dispatch_id: string;
  deadline: string;
  worker_generation?: string;
  accepted_at?: string;
  accounting?: Record<string, number>;
}
export interface RelayTaskReceipt {
  invocation_id: string;
  action_name: "task.run";
  status: "pending" | "dispatched" | "running" | "completed" | "failed";
  task_execution: RelayTaskExecution;
  output: unknown;
  error: string | null;
  completed_at: string | null;
}

/** GET is authoritative. A spawn/POST acknowledgment is never a task result. */
export function readTaskReceipt(
  value: unknown,
  invocationId: string,
  input: Record<string, unknown>,
  previous?: RelayTaskReceipt,
): RelayTaskReceipt {
  const context = input.task_context as Record<string, unknown>;
  if (
    !isRecord(value) ||
    value.invocation_id !== invocationId ||
    value.action_name !== "task.run" ||
    canonicalize(value.input) !== canonicalize(input) ||
    !isRecord(value.task_execution)
  ) {
    throw new Error("Relay task receipt has mismatched invocation or input");
  }
  const execution = value.task_execution;
  const validDate = (date: unknown): date is string =>
    nonempty(date) && Number.isFinite(Date.parse(date));
  if (
    !nonempty(execution.execution_id) ||
    !validDate(execution.deadline) ||
    ["run_id", "step_id", "dispatch_id"].some(
      (key) => execution[key] !== context[key],
    ) ||
    !["pending", "dispatched", "running", "completed", "failed"].includes(
      String(value.status),
    )
  ) {
    throw new Error("Relay task receipt has invalid execution correlation");
  }
  const accepted =
    nonempty(execution.worker_generation) && validDate(execution.accepted_at);
  if (
    (value.status === "running" || value.status === "completed") &&
    !accepted
  ) {
    throw new Error("Relay task receipt is missing durable acceptance");
  }
  if (
    previous !== undefined &&
    (previous.task_execution.deadline !== execution.deadline ||
      (previous.task_execution.worker_generation !== undefined &&
        (previous.task_execution.worker_generation !==
          execution.worker_generation ||
          previous.task_execution.execution_id !== execution.execution_id)))
  ) {
    throw new Error(
      "Relay task receipt changed its accepted generation or deadline",
    );
  }
  if (
    execution.accounting !== undefined &&
    (!isRecord(execution.accounting) ||
      Object.values(execution.accounting).some(
        (n) => typeof n !== "number" || !Number.isFinite(n) || n < 0,
      ))
  ) {
    throw new Error("Relay task receipt has invalid accounting");
  }
  if (
    value.status === "completed" &&
    (!Object.hasOwn(value, "output") ||
      value.error !== null ||
      !validDate(value.completed_at))
  ) {
    throw new Error("Relay task receipt has no authoritative final output");
  }
  if (
    value.status === "failed" &&
    (!nonempty(value.error) || !validDate(value.completed_at))
  ) {
    throw new Error("Relay task failure receipt has no reason");
  }
  return {
    invocation_id: invocationId,
    action_name: "task.run",
    status: value.status as RelayTaskReceipt["status"],
    task_execution: execution as unknown as RelayTaskExecution,
    output: value.output,
    error: value.error as string | null,
    completed_at: value.completed_at as string | null,
  };
}
