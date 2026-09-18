import { userInfo } from 'node:os';
import { readAuthoredRootMetadata } from '../authored-root.js';
import { HUMAN_WAIT_ID, humanAnswerPayload, readHumanAnswer, readOpenHumanWaits, resumeCommand } from '../authored-human.js';
import { JournalClient, JournalProtocolError } from '../journal-client.js';
import type { EnsureDaemonOptions } from '../daemon-lifecycle.js';
import { connect, emptyReport, protocolFailure, socketFor, type RunExecution } from './run.js';

export interface AnswerOptions {
  readonly note?: string;
  /** Who answered, when relaying a person's decision; defaults to the OS user. */
  readonly answeredBy?: string;
  readonly daemon?: EnsureDaemonOptions;
}

/**
 * `flows answer <run-id> <wait-id> yes|no`: record a person's answer to a
 * parked `f.human`. The answer is an `event.emit` keyed by the wait id; the
 * kernel closes the `wait.human` as `human_responded` and the root becomes
 * runnable. Nothing runs here — this process attaches no worker — so the
 * report names the `flows resume` that continues the body with the answer.
 */
export async function answerFlow(
  runId: string,
  waitId: string,
  answer: boolean,
  dataDir: string,
  options: AnswerOptions = {},
): Promise<RunExecution> {
  const socketPath = socketFor(dataDir);
  const base = emptyReport('answer');
  if (!HUMAN_WAIT_ID.test(waitId)) {
    return { exitCode: 2, report: { ...base, runId, socketPath, diagnostics: [{
      severity: 'refusal', kind: 'human_wait_unknown',
      message: `"${waitId}" is not an f.human wait id; they are named human-<n> in the order the body asked.`,
    }] } };
  }
  const client = new JournalClient(socketPath);
  const connected = await connect(client, 'answer', dataDir, base, { daemon: options.daemon ?? {} });
  if (connected !== undefined) return connected;
  try {
    const open = await readOpenHumanWaits(client, runId);
    const wait = open.find(candidate => candidate.waitId === waitId);
    if (wait === undefined) {
      const answered = await readHumanAnswer(client, runId, waitId).catch(() => undefined);
      const others = open.map(candidate => `${candidate.waitId} (${candidate.to}: ${JSON.stringify(candidate.question)})`);
      return { exitCode: 2, report: { ...base, runId, socketPath, diagnostics: [{
        severity: 'refusal', kind: 'human_wait_unknown',
        message: answered !== undefined
          ? `Run "${runId}" already has an answer to ${waitId} (${answered.answer ? 'yes' : 'no'}); the kernel closes a wait once.`
          : `Run "${runId}" is not asking ${waitId}.`
            + (others.length === 0 ? ' It has no open question.' : ` Open: ${others.join(', ')}.`),
      }] } };
    }
    const payload = humanAnswerPayload(answer, {
      ...(options.note === undefined ? {} : { note: options.note }),
      answeredBy: options.answeredBy ?? safeUsername(),
    });
    const emitted = await client.eventEmit(runId, waitId, payload);
    if (emitted.matched !== 1) {
      return protocolFailure('answer', base, socketPath, new Error(
        `event.emit matched ${emitted.matched} waits for ${waitId}; expected the one open question`,
      ), runId);
    }
    const snapshot = await client.runGet(runId);
    const root = await readAuthoredRootMetadata(client, runId).catch(() => undefined);
    return {
      exitCode: 0,
      report: {
        ...base, ok: true, runId, socketPath, status: snapshot.status,
        answer: { waitId, answer, ...(options.note === undefined ? {} : { note: options.note }) },
        humanWait: { waitId, question: wait.question, to: wait.to },
        next: resumeCommand(runId, dataDir, root?.localAgentStream !== undefined),
        diagnostics: [],
      },
    };
  } catch (error) {
    if (error instanceof JournalProtocolError && error.code === 'run_not_found') {
      return { exitCode: 2, report: { ...base, runId, socketPath, diagnostics: [{
        severity: 'refusal', kind: 'run_unavailable',
        message: `Run "${runId}" is not known to relayflowd at "${socketPath}".`,
      }] } };
    }
    return protocolFailure('answer', base, socketPath, error, runId);
  } finally {
    client.close();
  }
}

function safeUsername(): string {
  try { return userInfo().username; } catch { return ''; }
}
