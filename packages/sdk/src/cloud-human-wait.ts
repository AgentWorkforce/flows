import { HUMAN_WAIT_ID } from './authored-human.js';
import { isCloudRecord } from './cloud-http.js';
import { parseHumanTo, type HumanRecipient } from './human-to.js';

export interface CloudHumanWait {
  waitId: string;
  question?: string;
  to?: string;
  recipient?: HumanRecipient;
}

/** Missing display fields do not invalidate an attested park. */
export function readCloudHumanWaitValue(value: unknown): CloudHumanWait | undefined {
  if (!isCloudRecord(value) || typeof value.waitId !== 'string' || !HUMAN_WAIT_ID.test(value.waitId)) return undefined;
  const to = typeof value.to === 'string' ? value.to : undefined;
  const parsed = to === undefined ? undefined : parseHumanTo(to);
  return {
    waitId: value.waitId,
    ...(typeof value.question === 'string' ? { question: value.question } : {}),
    ...(to === undefined ? {} : { to }),
    ...(parsed?.ok ? { recipient: parsed.recipient } : {}),
  };
}
