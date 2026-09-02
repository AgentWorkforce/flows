import type { Ctx } from "./context.js";

/** Optional escalation header; the empty header is the common case. */
export interface FlowHeader {
  identity?: string;
  memory?: { script?: boolean; agent?: boolean };
  budget?: string;
  tools?: { relayfile?: string[]; mcp?: string[] };
  workspace?: string;
}

type FlowBody = (f: Ctx) => Promise<void>;

/** Opaque authored-flow handle. Execution stays behind the journal runtime. */
export interface FlowHandle {
  readonly name: string;
}

export function flow(name: string, body: FlowBody): FlowHandle;
export function flow(
  name: string,
  header: FlowHeader,
  body: FlowBody,
): FlowHandle;
export function flow(
  name: string,
  headerOrBody: FlowHeader | FlowBody,
  body?: FlowBody,
): FlowHandle {
  const flowBody = typeof headerOrBody === "function" ? headerOrBody : body;

  if (name.trim().length === 0) {
    throw new TypeError("flow name must not be empty");
  }
  if (flowBody === undefined) {
    throw new TypeError(`flow "${name}" requires a body`);
  }

  return Object.freeze({ name });
}
