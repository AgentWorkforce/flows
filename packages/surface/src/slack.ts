import type { Step } from "./step.js";
import type { SlackAttachment, SlackBlock } from "./helpers/slack.js";

export type { SlackAttachment, SlackBlock } from "./helpers/slack.js";

/** Structured message content. Text supplies the notification/accessibility fallback. */
export interface SlackPostMessage {
  text?: string;
  blocks?: SlackBlock[];
  attachments?: SlackAttachment[];
}

export interface SlackPostOptions extends Omit<SlackPostMessage, "text"> {
  replyTo?: string;
}

export interface SlackReceipt {
  channel: string;
  ts: string;
  ref: string;
}

/** Slack writeback helpers; every call is a journal-backed effect. */
export interface SlackHelper {
  post(channel: string, text: string | SlackPostMessage, opts?: SlackPostOptions): Step<SlackReceipt>;
  dm(user: string, text: string): Step<{ user: string; ts: string }>;
  reply(channel: string, threadTs: string, text: string): Step<SlackReceipt>;
  react(channel: string, messageTs: string, emoji: string): Step<void>;
}

/** Normalize both authoring forms to the adapter's JSON writeback body. */
export function slackPostBody(text: string | SlackPostMessage, opts?: SlackPostOptions): SlackPostMessage & { parentRef?: string } {
  const message = typeof text === "string" ? { text } : text;
  const blocks = opts?.blocks ?? message.blocks;
  const attachments = opts?.attachments ?? message.attachments;
  return {
    ...(message.text === undefined ? {} : { text: message.text }),
    ...(blocks === undefined ? {} : { blocks }),
    ...(attachments === undefined ? {} : { attachments }),
    ...(opts?.replyTo ? { parentRef: opts.replyTo } : {}),
  };
}

/** Stable across attempts; deliberately independent of process-tick ordinals. */
export function flowRunWritebackIdempotency(runId: string, stepId: string): string {
  return `${runId}:${stepId}`;
}
