import type { CliIo } from '../cli.js';
import { canonicalize } from '../canonical.js';
import { JournalReadError, walkJournal } from '../journal-client.js';

export interface ReplayArgs {
  command: 'replay';
  value: string;
  json: boolean;
  dataDir: string;
  at?: string;
}

export function parseReplayArgs(args: readonly string[]): ReplayArgs | undefined {
  let json = false;
  let dataDir: string | undefined;
  let at: string | undefined;
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--json') {
      if (json) return undefined;
      json = true;
    } else if (argument === '--data-dir' || argument === '--at') {
      const value = args[++index];
      if (value === undefined || value.length === 0 || value.startsWith('-')) return undefined;
      if (argument === '--data-dir') {
        if (dataDir !== undefined) return undefined;
        dataDir = value;
      } else {
        if (at !== undefined) return undefined;
        at = value;
      }
    } else if (argument.startsWith('-')) {
      return undefined;
    } else {
      positionals.push(argument);
    }
  }
  if (positionals.length !== 1) return undefined;
  return { command: 'replay', value: positionals[0]!, json, dataDir: dataDir ?? '.relayflowd', at };
}

export async function replayJournal(args: ReplayArgs, io: CliIo): Promise<0 | 1 | 2> {
  let emitted = false;
  try {
    for await (const event of walkJournal(args.value, args.dataDir, { at: args.at })) {
      const payload = event.payload !== null && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown> : {};
      io.stdout(args.json ? canonicalize({
        step_id: event.step_id,
        kind: event.entry_type,
        event,
        verification: payload['verification'] ?? null,
        spend: payload['budget'] ?? payload['budget_total'] ?? null,
      })
        : `${event.seq} ${event.at_ms} ${event.entry_type}`
          + (event.step_id === null ? '' : ` step=${JSON.stringify(event.step_id)}`)
          + (event.attempt === null ? '' : ` attempt=${event.attempt}`)
          + ` ${canonicalize(event.payload)}`);
      emitted = true;
    }
    return 0;
  } catch (error) {
    const diagnostic = {
      severity: 'refusal',
      kind: error instanceof JournalReadError ? error.code : 'journal_read_failed',
      message: error instanceof Error ? error.message : String(error),
    };
    io.stderr(`${emitted ? 'FAILED' : 'REFUSED'} [${diagnostic.kind}] ${diagnostic.message}`);
    return emitted ? 1 : 2;
  }
}
