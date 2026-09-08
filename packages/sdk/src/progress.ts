import type { CompletionReason } from './protocol.js';
import type { StepType } from './spec.js';

export interface ProgressEvent {
  type: 'step.started' | 'step.running' | 'step.completed' | 'step.failed';
  stepId: string;
  stepType: StepType;
  elapsedMs: number;
  completionReason?: CompletionReason;
}

/** Pure terminal rendering: caller owns the event source, clock, and output. */
export function renderProgress(events: Iterable<ProgressEvent>): string[] {
  return Array.from(events, event => {
    const icon = { 'step.started': '○', 'step.running': '↻', 'step.completed': '✓', 'step.failed': '✗' }[event.type];
    const state = event.type.slice('step.'.length);
    const agent = event.stepType === 'agent' ? ` [agent: ${state === 'started' ? 'preparing' : state}]` : '';
    const reason = event.completionReason ? ` completionReason: ${event.completionReason}` : '';
    // Agent-authored names cannot inject terminal control sequences.
    const name = event.stepId.replace(/[\x00-\x1f\x7f-\x9f]/g, '?');
    return `${icon} ${name} (${event.stepType})${agent} ${(Math.max(0, event.elapsedMs) / 1000).toFixed(2)}s${reason}`;
  });
}

/** Observe the existing executor; success is emitted only after its journal read. */
export async function observeStep<T>(
  stepId: string,
  stepType: StepType,
  execute: () => Promise<T>,
  emit?: (event: ProgressEvent) => void,
): Promise<T> {
  const publish = (event: ProgressEvent): void => {
    try { emit?.(event); } catch {
      // A projection failure must not turn a journaled success into a retry,
      // or replace the executor's original failure. Surface it separately.
      process.emitWarning(`Progress observer failed for ${event.type}.`, {
        code: 'FLOWS_PROGRESS_OBSERVER_ERROR',
      });
    }
  };
  const started = performance.now();
  publish({ type: 'step.started', stepId, stepType, elapsedMs: 0 });
  try {
    const result = await execute();
    publish({ type: 'step.completed', stepId, stepType, elapsedMs: performance.now() - started, completionReason: 'success' });
    return result;
  } catch (error) {
    publish({ type: 'step.failed', stepId, stepType, elapsedMs: performance.now() - started });
    throw error;
  }
}
