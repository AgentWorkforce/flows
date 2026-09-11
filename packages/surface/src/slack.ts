import type { Step } from "./step.js";

export interface SlackReceipt {
  channel: string;
  ts: string;
  ref: string;
}

/** Slack writeback helpers; every call is a journal-backed effect. */
export interface SlackHelper {
  post(channel: string, text: string, opts?: { replyTo?: string }): Step<SlackReceipt>;
  dm(user: string, text: string): Step<{ user: string; ts: string }>;
  reply(channel: string, threadTs: string, text: string): Step<SlackReceipt>;
  react(channel: string, messageTs: string, emoji: string): Step<void>;
}

/** Stable across attempts; deliberately independent of process-tick ordinals. */
export function flowRunWritebackIdempotency(runId: string, stepId: string): string {
  return `${runId}:${stepId}`;
}
