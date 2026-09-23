/**
 * Fold a run's journal entries, as `run.start {watch}` or `run.watch` pushes
 * them, into a `RunProjection`: `run.spawned` opens it with the declared step
 * graph, attempt starts and completions become step transitions, and
 * `run.completed` closes it. Entries journaled before `liveSinceMs` (a resume
 * replaying history) update the snapshot without publishing a message each.
 */

import type { JournalEvent } from './journal-reader.js';
import type { ProgressEvent } from './progress.js';
import type { DeclaredStep, RunProjection, RunSnapshot } from './run-projection.js';
import type { StepType } from './spec.js';

export type OpenProjection = (run: { runId: string; flow: string; steps: DeclaredStep[] }) => RunProjection;

export function createJournalProjector(open: OpenProjection, liveSinceMs = 0): (entry: JournalEvent) => void {
  let projection: RunProjection | undefined;
  const types = new Map<string, StepType>();
  const started = new Map<string, number>();

  return entry => {
    const payload = (entry.payload ?? {}) as Record<string, unknown>;
    const live = entry.at_ms >= liveSinceMs;
    if (entry.entry_type === 'run.spawned') {
      if (projection !== undefined) return;
      const spec = (payload['spec'] ?? {}) as { name?: unknown; steps?: unknown };
      const steps = (Array.isArray(spec.steps) ? spec.steps : []).flatMap(declaredStep);
      for (const step of steps) types.set(step.id, step.type);
      projection = open({ runId: entry.run_id, flow: typeof spec.name === 'string' ? spec.name : 'flow', steps });
      return;
    }
    if (projection === undefined || entry.step_id === null && entry.entry_type !== 'run.completed') return;
    const stepId = entry.step_id ?? '';
    const stepType = types.get(stepId) ?? 'deterministic';
    const attempt = entry.attempt ?? undefined;
    const key = `${stepId}#${attempt ?? 0}`;
    const event = (type: ProgressEvent['type'], completionReason?: string): void => {
      const elapsedMs = type === 'step.started' ? 0 : entry.at_ms - (started.get(key) ?? entry.at_ms);
      projection!.step({
        type, stepId, stepType, elapsedMs,
        ...(attempt === undefined ? {} : { attempt }),
        ...(completionReason === undefined ? {} : { completionReason: completionReason as never }),
      }, live);
    };
    switch (entry.entry_type) {
      case 'step.attempt.started':
        started.set(key, entry.at_ms);
        event('step.started');
        return;
      case 'wait.human':
        event('step.parked');
        return;
      case 'step.completed': {
        const reason = typeof payload['completionReason'] === 'string' ? payload['completionReason'] : undefined;
        const parked = payload['disposition'] === 'park';
        event(parked ? 'step.parked' : reason === 'success' ? 'step.completed' : 'step.failed', reason);
        return;
      }
      case 'run.completed': {
        const reason = typeof payload['completionReason'] === 'string' ? payload['completionReason'] : undefined;
        projection.finish({ status: runStatus(reason), ...(reason === undefined ? {} : { completionReason: reason }) });
        return;
      }
    }
  };
}

function declaredStep(value: unknown): DeclaredStep[] {
  if (typeof value !== 'object' || value === null) return [];
  const step = value as { id?: unknown; type?: unknown; depends_on?: unknown };
  if (typeof step.id !== 'string') return [];
  const type = step.type === 'llm' || step.type === 'agent' ? step.type : 'deterministic';
  const dependsOn = Array.isArray(step.depends_on)
    ? step.depends_on.filter((id): id is string => typeof id === 'string') : [];
  return [{ id: step.id, type, dependsOn }];
}

function runStatus(reason: string | undefined): RunSnapshot['status'] {
  if (reason === 'success') return 'completed';
  if (reason === 'canceled') return 'canceled';
  return 'failed';
}
