import type { StepDispatchEvent } from './protocol.js';

/** Memory precedes the final, visibly delimited JSON input segment. */
export function workerInstruction(instruction: string, dispatch: StepDispatchEvent): string {
  const withMemory = dispatch.memory === undefined ? instruction
    : `${instruction}\n\nMemory context (journaled):\n${JSON.stringify(dispatch.memory.pack)}`;
  if (dispatch.input === undefined) {
    if (typeof dispatch.spec === 'object' && dispatch.spec !== null
      && 'input' in dispatch.spec) {
      throw new Error('Step declares input bindings but the kernel did not resolve them; upgrade relayflowd.');
    }
    return withMemory;
  }
  return `${withMemory}\n\ninput:\n${JSON.stringify(dispatch.input)}`;
}
