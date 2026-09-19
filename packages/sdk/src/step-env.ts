// The four names a worker exports so an agent can find its own run on disk.
//
// Set on every direct claude/codex attempt that has a data directory
// (worker-cli.ts), and read by `flows status` when it is invoked with no run
// id. Identifiers and a path only: with these an agent can open its journal
// and nothing else. Env rather than a file in cwd because a cwd file pollutes
// the workspace, goes stale after a crash and breaks when `spec.cwd` is
// shared; the environment dies with the attempt.

import { resolve } from 'node:path';

export const DATA_DIR_ENV = 'RELAYFLOW_DATA_DIR';
export const RUN_ID_ENV = 'RELAYFLOW_RUN_ID';
export const STEP_ID_ENV = 'RELAYFLOW_STEP_ID';
export const ATTEMPT_ENV = 'RELAYFLOW_ATTEMPT';

export const STEP_ENV_NAMES = [DATA_DIR_ENV, RUN_ID_ENV, STEP_ID_ENV, ATTEMPT_ENV] as const;

export interface StepIdentity {
  dataDir: string;
  runId: string;
  stepId: string;
  attempt: number;
}

/**
 * Overwrite the four names in `env` from `identity`, or remove them when there
 * is none. Removal matters: a worker that is itself running inside a step
 * inherits its parent's values, and an agent must not mistake them for its own.
 * The data dir is made absolute because the agent's cwd may be `spec.cwd`.
 */
export function applyStepEnvironment(env: NodeJS.ProcessEnv, identity: StepIdentity | undefined): void {
  for (const name of STEP_ENV_NAMES) delete env[name];
  if (identity === undefined) return;
  env[DATA_DIR_ENV] = resolve(identity.dataDir);
  env[RUN_ID_ENV] = identity.runId;
  env[STEP_ID_ENV] = identity.stepId;
  env[ATTEMPT_ENV] = String(identity.attempt);
}
