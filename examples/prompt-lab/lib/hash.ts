import { createHash } from "node:crypto";

/** A stable short id for a value: the same journaled inputs name the same work file. */
export const hash8 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 8);
