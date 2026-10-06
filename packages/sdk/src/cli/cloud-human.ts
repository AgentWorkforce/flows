import { cloudAnswerCommand } from '../authored-human.js';
import type { CloudHumanWait } from '../cloud-human-wait.js';
import type { CloudRunState } from '../cloud-run-record.js';
import { redact } from '../redact.js';
import { safe } from './cloud-format.js';

export function scrubCloudHumanWait(wait: CloudHumanWait | undefined, env = process.env): CloudHumanWait | undefined {
  if (!wait) return undefined;
  return {
    ...wait,
    ...(wait.recipient === undefined ? {} : { recipient: { ...wait.recipient, target: safe(redact(wait.recipient.target, env)) } }),
    ...(wait.question === undefined ? {} : { question: safe(redact(wait.question, env)) }),
    ...(wait.to === undefined ? {} : { to: safe(redact(wait.to, env)) }),
  };
}

export function cloudParkLines(state: Extract<CloudRunState, { status: 'needs_human' }>, env = process.env): string[] {
  const wait = scrubCloudHumanWait(state.humanWait, env);
  return [
    `NEEDS_HUMAN ${state.runId} completionReason: needs_human`,
    ...(wait ? [`Waiting for ${wait.to ?? '(recipient unavailable)'} to answer ${wait.waitId}: ${JSON.stringify(wait.question ?? '(question unavailable)')}`] : []),
    `Answer with: ${cloudAnswerCommand(state.runId)}`,
  ];
}
