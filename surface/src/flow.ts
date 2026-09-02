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

const definitions = new WeakMap<object, AuthoredFlowDefinition>();

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
  assertFlowHeader(header, name);

  const definition: AuthoredFlowDefinition = Object.freeze({
    name,
    header: freezeHeader(header),
    body: flowBody,
  });
  const handle: FlowHandle = Object.freeze({ name });
  definitions.set(handle, definition);
  return handle;
}

/**
 * Runtime bridge used by the SDK after it imports an authored `.flow.ts`.
 * The root package deliberately does not re-export this accessor.
 */
export function getFlowDefinition(handle: FlowHandle): AuthoredFlowDefinition {
  if ((typeof handle !== "object" && typeof handle !== "function") || handle === null) {
    throw new TypeError("expected an @relayflows/surface flow handle");
  }
  const definition = definitions.get(handle);
  if (
    definition === undefined
    || !isStoredDefinition(definition, definition.name)
    || handle.name !== definition.name
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

function assertFlowHeader(value: unknown, flowName: string): asserts value is FlowHeader {
  const at = `unsupported_header: flow "${flowName}" header`;
  assertHeaderObject(value, at);
  assertKnownKeys(
    value,
    ["identity", "memory", "budget", "tools", "workspace"],
    at,
  );
  assertOptionalString(value, "identity", at);
  assertOptionalString(value, "budget", at);
  assertOptionalString(value, "workspace", at);

  if (value.memory !== undefined) {
    assertHeaderObject(value.memory, `${at}.memory`);
    assertKnownKeys(
      value.memory,
      ["script", "agent"],
      `${at}.memory`,
    );
    assertOptionalBoolean(value.memory, "script", `${at}.memory`);
    assertOptionalBoolean(value.memory, "agent", `${at}.memory`);
  }

  if (value.tools !== undefined) {
    assertHeaderObject(value.tools, `${at}.tools`);
    assertKnownKeys(
      value.tools,
      ["relayfile", "mcp"],
      `${at}.tools`,
    );
    assertOptionalStringArray(value.tools, "relayfile", `${at}.tools`);
    assertOptionalStringArray(value.tools, "mcp", `${at}.tools`);
  }
}

function assertHeaderObject(
  value: unknown,
  at: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${at}: expected an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${at}: expected a plain object`);
  }
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
): void {
  const allowedKeys = new Set<PropertyKey>(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`${at}: unknown field ${JSON.stringify(String(key))}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`${at}.${String(key)}: expected a data property`);
    }
  }
}

function assertOptionalString(
  value: Record<string, unknown>,
  key: string,
  at: string,
): void {
  if (value[key] !== undefined && typeof value[key] !== "string") {
    throw new TypeError(`${at}.${key}: expected a string`);
  }
}

function assertOptionalBoolean(
  value: Record<string, unknown>,
  key: string,
  at: string,
): void {
  if (value[key] !== undefined && typeof value[key] !== "boolean") {
    throw new TypeError(`${at}.${key}: expected a boolean`);
  }
}

function assertOptionalStringArray(
  value: Record<string, unknown>,
  key: string,
  at: string,
): void {
  const candidate = value[key];
  if (
    candidate !== undefined
    && (!Array.isArray(candidate) || candidate.some((item) => typeof item !== "string"))
  ) {
    throw new TypeError(`${at}.${key}: expected an array of strings`);
  }
}
