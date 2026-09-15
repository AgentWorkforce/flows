import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalize } from "./canonical.js";

export interface RelayTaskClaim {
  version: 1;
  baseUrl: string;
  callerId: string;
  workspaceId: string;
  invocationId: string;
  runId: string;
  stepId: string;
  idempotencyKey: string;
  input: Record<string, unknown>;
  startedAt: number;
}

/** Exclusive creation pins the request before POST; no last-writer overwrite. */
export async function claimRelayTask(
  dataDir: string,
  claim: RelayTaskClaim,
): Promise<{ claim: RelayTaskClaim; created: boolean }> {
  const directory = join(dataDir, "relay-tasks");
  await mkdir(directory, { recursive: true });
  const parent = await open(dataDir, "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  const digest = createHash("sha256")
    .update(canonicalize([claim.runId, claim.stepId, claim.idempotencyKey]))
    .digest("hex");
  const path = join(directory, `${digest}.json`);
  let file;
  try {
    file = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const prior: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof prior !== "object" ||
      prior === null ||
      !("startedAt" in prior) ||
      typeof prior.startedAt !== "number" ||
      !Number.isSafeInteger(prior.startedAt) ||
      prior.startedAt < 0 ||
      canonicalize(prior) !==
        canonicalize({ ...claim, startedAt: prior.startedAt })
    ) {
      throw new Error(
        "Relay task dispatch conflicts with its durable caller, endpoint, or input",
      );
    }
    return { claim: prior as RelayTaskClaim, created: false };
  }
  // A crash during creation leaves a partial claim that fails closed on read.
  // Never remove an uncertain claim and retry under a different identity.
  try {
    await file.writeFile(canonicalize(claim));
    await file.sync();
  } finally {
    await file.close();
  }
  const dir = await open(directory, "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
  return { claim, created: true };
}
