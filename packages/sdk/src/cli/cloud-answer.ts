import { cloudAnswerCommand } from '../authored-human.js';
import { shellWord } from '../shell-word.js';
import { answerCloudFlow, CloudAnswerError } from '../cloud-answer.js';
import { CloudFlowError } from '../cloud-http.js';
import { redact } from '../redact.js';
import { safe } from './cloud-format.js';
import type { CliIo } from '../cli.js';

export async function runCloudAnswerCli(
  args: { runId: string; answer: boolean; note?: string; source?: string; json: boolean },
  io: CliIo,
  signal: AbortSignal,
): Promise<0 | 1 | 2> {
  try {
    const receipt = await answerCloudFlow(args.runId, args.answer, { ...args, signal });
    if (args.json) io.stdout(JSON.stringify({ ok: true, ...receipt }));
    else {
      io.stdout(`ANSWERED ${receipt.resumedFrom} ${receipt.waitId} ${receipt.answer ? 'yes' : 'no'}`);
      io.stdout(`RESUMED ${receipt.runId}${receipt.resumedByCloud ? ' (by Cloud)' : ''}`);
    }
    return 0;
  } catch (error) {
    const partial = error instanceof CloudAnswerError;
    const cause = partial ? error.cause : error;
    const code = partial ? 'cloud_answer_incomplete' : cause instanceof CloudFlowError ? cause.code : 'cloud_answer_failed';
    const detail = partial && cause instanceof Error ? ` ${cause.message}` : '';
    const message = safe(redact((error instanceof Error ? error.message : 'Cloud answer failed.') + detail, process.env));
    const retry = partial ? cloudAnswerCommand(args.runId).replace(/yes\|no$/u, args.answer ? 'yes' : 'no')
      + (args.source === undefined ? '' : ` --source ${shellWord(args.source)}`)
      + (args.note === undefined ? '' : ` --note ${shellWord(args.note)}`) : undefined;
    const next = retry === undefined ? undefined : safe(redact(retry, process.env));
    if (args.json) io.stdout(JSON.stringify({ ok: false, code, message, runId: args.runId,
      ...(partial ? { answerRecorded: error.answerRecorded, next } : {}) }));
    else {
      io.stderr(`${code}: ${message}`);
      if (next) io.stderr(`After checking Cloud status, retry with: ${next}`);
    }
    return !partial && cause instanceof CloudFlowError && ['configuration', 'invalid_input', 'unsupported_source'].includes(cause.code) ? 2 : 1;
  }
}
