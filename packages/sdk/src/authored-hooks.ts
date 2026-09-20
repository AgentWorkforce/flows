import type { Ctx } from '@relayflows/surface';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';
import type { LoadedFlowExtension } from './flow-extension-loader.js';
import type { JournalClient } from './journal-client.js';

const HOOK_STREAM = 'hooks';

export interface HookRecord {
  hook: string;
  step: string;
  plugin: string | null;
  verdict: 'pass' | 'fail' | 'noop';
  because?: string;
}

function recordKey(record: HookRecord): string {
  return `${record.step}:${record.plugin ?? 'noop'}`;
}

/**
 * AND-compose installed hook implementations in lock order. Verdicts are
 * appended to the root run's `hooks` stream before the boolean is returned,
 * so a resume reads the recorded verdict and never re-runs the closure.
 * No implementations is a journaled no-op returning true. A false short-circuits.
 */
export function createHookEvaluator(options: {
  readonly journal: JournalClient;
  readonly rootRunId?: string;
  readonly flowName: string;
  readonly declared: readonly string[];
  readonly extensions: readonly LoadedFlowExtension[];
}): (id: string, name: string, input: unknown, context: Ctx) => Promise<boolean> {
  let recorded: Promise<Map<string, HookRecord>> | undefined;

  async function load(): Promise<Map<string, HookRecord>> {
    const verdicts = new Map<string, HookRecord>();
    if (options.rootRunId === undefined) return verdicts;
    let offset = 0;
    for (;;) {
      const page = await options.journal.streamRead(options.rootRunId, HOOK_STREAM, offset, 1000);
      for (const message of page.messages) {
        const raw = (message as { message?: unknown }).message ?? message;
        if (typeof raw !== 'object' || raw === null) continue;
        const record = raw as HookRecord;
        if (typeof record.hook !== 'string' || typeof record.step !== 'string') continue;
        if (record.verdict !== 'pass' && record.verdict !== 'fail' && record.verdict !== 'noop') continue;
        if (record.plugin !== null && typeof record.plugin !== 'string') continue;
        verdicts.set(recordKey(record), record);
      }
      if (page.messages.length === 0 || page.next_offset <= offset) break;
      offset = page.next_offset;
    }
    return verdicts;
  }

  async function lookup(key: string): Promise<HookRecord | undefined> {
    if (options.rootRunId === undefined) return undefined;
    recorded ??= load();
    return (await recorded).get(key);
  }

  async function append(record: HookRecord): Promise<void> {
    if (options.rootRunId === undefined) return;
    recorded ??= load();
    await options.journal.streamAppend(options.rootRunId, HOOK_STREAM, record);
    (await recorded).set(recordKey(record), record);
  }

  return async (id, name, input, context) => {
    if (!options.declared.includes(name)) {
      throw new AuthoredFlowExecutionError(
        'unsupported_verb',
        `hook "${name}" is not declared by flow "${options.flowName}"`,
      );
    }
    const impls = options.extensions.filter(extension => extension.hooks[name] !== undefined);
    if (impls.length === 0) {
      const existing = await lookup(`${id}:noop`);
      const record = existing ?? { hook: name, step: id, plugin: null, verdict: 'noop' as const };
      if (existing === undefined) await append(record);
      return true;
    }
    for (const extension of impls) {
      const key = `${id}:${extension.name}`;
      let record = await lookup(key);
      if (record === undefined) {
        let verdict = false;
        let because: string | undefined;
        try {
          verdict = await extension.hooks[name]!(context, input) === true;
        } catch (error) {
          verdict = false;
          because = error instanceof Error ? error.message : String(error);
        }
        record = {
          hook: name, step: id, plugin: extension.name,
          verdict: verdict ? 'pass' : 'fail',
          ...(because === undefined ? {} : { because }),
        };
        await append(record);
      }
      if (record.verdict === 'fail') return false;
    }
    return true;
  };
}
