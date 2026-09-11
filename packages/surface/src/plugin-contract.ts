import type { Step } from './step.js';

/** Plugins augment Ctx in @relayflows/surface; no catch-all index signature. */
export type PluginMethod<Args, Output = unknown> = (args: Args) => Step<Output>;
export type PluginPrimitive = 'run' | 'llm' | 'agent' | 'effect' | 'wait';
