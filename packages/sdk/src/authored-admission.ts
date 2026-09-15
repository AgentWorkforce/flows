import { createHash } from 'node:crypto';

/** Stable retry identity for one operation in one durable authored root. */
export function authoredChildAdmissionKey(
  rootRunId: string | undefined,
  stepId: string,
): string | undefined {
  if (rootRunId === undefined) return undefined;
  return `authored-child:${createHash('sha256').update(`${rootRunId}\0${stepId}`).digest('hex')}`;
}

/** Stable local worker surface for retries of one caller-owned root start. */
export function authoredLocalAgentStream(admissionIdentity: string): string {
  return `local-agent-${createHash('sha256')
    .update(`authored-root-worker\0${admissionIdentity}`)
    .digest('hex')}`;
}
