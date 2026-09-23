import type { Ctx } from "@relayflows/surface";
import type { Lab } from "../lib/lab.ts";

/** What every job gets: the flow context, the lab store, and who answers its gates. */
export interface Job { f: Ctx; lab: Lab; labDir: string; reviewer: string }
