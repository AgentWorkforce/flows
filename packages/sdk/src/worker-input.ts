import type { StepDispatchEvent } from './protocol.js';

/** Memory precedes the final, visibly delimited JSON input segment. */
export function workerInstruction(instruction: string, dispatch: StepDispatchEvent): string {
  const withMemory = dispatch.memory === undefined ? instruction
    : `${instruction}\n\nMemory context (journaled):\n${JSON.stringify(dispatch.memory.pack)}`;
  const noted = `${withMemory}${recoveryNote(dispatch)}`;
  if (dispatch.input === undefined) {
    if (typeof dispatch.spec === 'object' && dispatch.spec !== null
      && 'input' in dispatch.spec) {
      throw new Error('Step declares input bindings but the kernel did not resolve them; upgrade relayflowd.');
    }
    return noted;
  }
  return `${noted}\n\ninput:\n${JSON.stringify(dispatch.input)}`;
}

/** Absent on the first attempt. Null and undefined are both "the kernel had nothing". */
function recoveryNote(dispatch: StepDispatchEvent): string {
  const reason = dispatch.recovery?.previous_completion_reason;
  const tail = dispatch.recovery?.trajectory_tail;
  if ((reason === undefined || reason === null) && (tail === undefined || tail === null)) return '';
  return `\n\nPrevious attempt (journaled):\n${JSON.stringify({
    completion_reason: reason ?? null,
    trajectory_tail: tail ?? null,
  })}`;
}
