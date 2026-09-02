import type { Ctx } from "./context.js";

/** Optional escalation header; the empty header is the common case. */
export interface FlowHeader {
  identity?: string;
  memory?: { script?: boolean; agent?: boolean };
  budget?: string;
  tools?: { relayfile?: string[]; mcp?: string[] };
  workspace?: string;
}

export type FlowBody = (f: Ctx) => Promise<void>;

export interface ReadonlyFlowHeader {
  readonly identity?: string;
  readonly memory?: Readonly<{ script?: boolean; agent?: boolean }>;
  readonly budget?: string;
  readonly tools?: Readonly<{
    relayfile?: readonly string[];
    mcp?: readonly string[];
  }>;
  readonly workspace?: string;
}

/** Immutable definition retained for the SDK's journal-backed runtime. */
export interface AuthoredFlowDefinition {
  readonly name: string;
  readonly header: ReadonlyFlowHeader;
  readonly body: FlowBody;
}

/** Opaque authored-flow handle. Execution stays behind the journal runtime. */
export interface FlowHandle {
  readonly name: string;
}

const DEFINITION = Symbol.for("@relayflows/surface.authored-definition.v1");

type StoredFlowHandle = FlowHandle & {
  readonly [DEFINITION]: AuthoredFlowDefinition;
};

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
  const header = typeof headerOrBody === "function" ? {} : headerOrBody;

  if (name.trim().length === 0) {
    throw new TypeError("flow name must not be empty");
  }
  if (typeof flowBody !== "function") {
    throw new TypeError(`flow "${name}" requires a body`);
  }

  const definition: AuthoredFlowDefinition = Object.freeze({
    name,
    header: freezeHeader(header),
    body: flowBody,
  });
  const handle = { name } as StoredFlowHandle;
  Object.defineProperty(handle, DEFINITION, {
    value: definition,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(handle);
}

/**
 * Runtime bridge used by the SDK after it imports an authored `.flow.ts`.
 * The root package deliberately does not re-export this accessor.
 */
export function getFlowDefinition(handle: FlowHandle): AuthoredFlowDefinition {
  if ((typeof handle !== "object" && typeof handle !== "function") || handle === null) {
    throw new TypeError("expected an @relayflows/surface flow handle");
  }
  const definition = (handle as Partial<StoredFlowHandle>)[DEFINITION];
  const descriptor = Object.getOwnPropertyDescriptor(handle, DEFINITION);
  if (
    !isStoredDefinition(definition, handle.name)
    || descriptor === undefined
    || descriptor.enumerable
    || descriptor.configurable
    || descriptor.writable
  ) {
    throw new TypeError("expected an @relayflows/surface flow handle");
  }
  return definition;
}

function isStoredDefinition(
  value: unknown,
  handleName: unknown,
): value is AuthoredFlowDefinition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<AuthoredFlowDefinition>;
  return typeof handleName === "string"
    && candidate.name === handleName
    && typeof candidate.body === "function"
    && typeof candidate.header === "object"
    && candidate.header !== null
    && !Array.isArray(candidate.header)
    && Object.isFrozen(candidate.header)
    && Object.isFrozen(value);
}

function freezeHeader(header: FlowHeader): ReadonlyFlowHeader {
  const memory = header.memory === undefined
    ? undefined
    : Object.freeze({ ...header.memory });
  const tools = header.tools === undefined
    ? undefined
    : Object.freeze({
        ...(header.tools.relayfile === undefined
          ? {}
          : { relayfile: Object.freeze([...header.tools.relayfile]) }),
        ...(header.tools.mcp === undefined
          ? {}
          : { mcp: Object.freeze([...header.tools.mcp]) }),
      });
  return Object.freeze({
    ...(header.identity === undefined ? {} : { identity: header.identity }),
    ...(memory === undefined ? {} : { memory }),
    ...(header.budget === undefined ? {} : { budget: header.budget }),
    ...(tools === undefined ? {} : { tools }),
    ...(header.workspace === undefined ? {} : { workspace: header.workspace }),
  });
}
