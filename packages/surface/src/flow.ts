import type { Ctx } from "./context.js";

/**
 * A reusable agent CLI/model pair, selectable by name from `f.agent(name, ...)`.
 * Both fields are required so selecting a named agent can never inherit a
 * host model — mirrors the kernel-spec dialect's `NamedAgentSpec`
 * (`packages/sdk/src/spec.ts`), which this compiles into.
 */
export interface NamedAgentDeclaration {
  cli: string;
  model: string;
}

/** Optional escalation header; the empty header is the common case. */
export interface FlowHeader {
  identity?: string;
  memory?: { script?: boolean; agent?: boolean };
  budget?: string;
  tools?: { relayfile?: string[]; mcp?: string[] };
  workspace?: string;
  agents?: Record<string, NamedAgentDeclaration>;
}

export type FlowBody<Input = unknown> = (f: Ctx, input: Input) => Promise<void>;

export interface ReadonlyFlowHeader {
  readonly identity?: string;
  readonly memory?: Readonly<{ script?: boolean; agent?: boolean }>;
  readonly budget?: string;
  readonly tools?: Readonly<{
    relayfile?: readonly string[];
    mcp?: readonly string[];
  }>;
  readonly workspace?: string;
  readonly agents?: Readonly<Record<string, Readonly<NamedAgentDeclaration>>>;
}

/** Immutable definition retained for the SDK's journal-backed runtime. */
export interface AuthoredFlowDefinition<Input = unknown> {
  readonly name: string;
  readonly header: ReadonlyFlowHeader;
  readonly body: FlowBody<Input>;
}

/** Opaque authored-flow handle. Execution stays behind the journal runtime. */
export interface FlowHandle {
  readonly name: string;
}

const definitions = new WeakMap<object, AuthoredFlowDefinition>();

export function flow<Input = unknown>(name: string, body: FlowBody<Input>): FlowHandle;
export function flow<Input = unknown>(
  name: string,
  header: FlowHeader,
  body: FlowBody<Input>,
): FlowHandle;
export function flow<Input = unknown>(
  name: string,
  headerOrBody: FlowHeader | FlowBody<Input>,
  body?: FlowBody<Input>,
): FlowHandle {
  const flowBody = typeof headerOrBody === "function" ? headerOrBody : body;
  const header = snapshotHeader(typeof headerOrBody === "function" ? {} : headerOrBody, `unsupported_header: flow "${name}" header`);

  if (name.trim().length === 0) {
    throw new TypeError("flow name must not be empty");
  }
  if (typeof flowBody !== "function") {
    throw new TypeError(`flow "${name}" requires a body`);
  }
  assertFlowHeader(header, name);

  const definition: AuthoredFlowDefinition<Input> = Object.freeze({
    name,
    header: freezeHeader(header),
    body: flowBody,
  });
  const handle: FlowHandle = Object.freeze({ name });
  // One map holds definitions of many input types, so it is stored at the
  // default parameterisation and `getFlowDefinition<Input>` re-parameterises on
  // the way out. The cast is needed because `body` puts `Input` in a parameter
  // position, making the type invariant: `AuthoredFlowDefinition<Input>` is not
  // assignable to `AuthoredFlowDefinition<unknown>` even though every read
  // recovers the author's own type. Sound here because the handle-to-definition
  // pairing is 1:1 and both sides are keyed by the same authored flow.
  definitions.set(handle, definition as AuthoredFlowDefinition);
  return handle;
}

/**
 * Runtime bridge used by the SDK after it imports an authored `.flow.ts`.
 * The root package deliberately does not re-export this accessor.
 */
export function getFlowDefinition<Input = unknown>(handle: FlowHandle): AuthoredFlowDefinition<Input> {
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

/** Capture descriptor values once; validation and freezing only see inert data. */
function snapshotHeader(value: unknown, at = "header", ancestors = new Set<object>()): FlowHeader {
  if (typeof value !== "object" || value === null) return value as FlowHeader;
  if (ancestors.has(value)) throw new TypeError(`${at}: circular header data`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = ownDataEntries(value as unknown as Record<string, unknown>, at);
      const result: unknown[] = [];
      for (const [key, item] of entries) {
        if (key === "length") continue;
        Object.defineProperty(result, key, {
          value: snapshotHeader(item, `${at}.${key}`, ancestors), enumerable: true,
        });
      }
      return result as unknown as FlowHeader;
    }
    assertHeaderObject(value, at);
    return Object.fromEntries(ownDataEntries(value, at).map(([key, item]) => [
      key, snapshotHeader(item, `${at}.${key}`, ancestors),
    ]));
  } finally {
    ancestors.delete(value);
  }
}

function freezeHeader(header: FlowHeader): ReadonlyFlowHeader {
  const unknownFields = Object.keys(header).filter((field) => ![
    "identity",
    "memory",
    "budget",
    "tools",
    "workspace",
    "agents",
  ].includes(field));
  if (unknownFields.length > 0) {
    throw new TypeError(`flow header has unknown fields: ${unknownFields.join(", ")}`);
  }
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
  const agents = header.agents === undefined
    ? undefined
    : Object.freeze(
        Object.fromEntries(
          ownDataEntries(header.agents, "header.agents").map(([name, declaration]) => {
            const record = declaration as NamedAgentDeclaration;
            return [name, Object.freeze({ cli: record.cli, model: record.model })];
          }),
        ),
      );
  return Object.freeze({
    ...(header.identity === undefined ? {} : { identity: header.identity }),
    ...(memory === undefined ? {} : { memory }),
    ...(header.budget === undefined ? {} : { budget: header.budget }),
    ...(tools === undefined ? {} : { tools }),
    ...(header.workspace === undefined ? {} : { workspace: header.workspace }),
    ...(agents === undefined ? {} : { agents }),
  });
}

function assertFlowHeader(value: unknown, flowName: string): asserts value is FlowHeader {
  const at = `unsupported_header: flow "${flowName}" header`;
  assertHeaderObject(value, at);
  assertKnownKeys(
    value,
    ["identity", "memory", "budget", "tools", "workspace", "agents"],
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

  if (value.agents !== undefined) {
    assertHeaderObject(value.agents, `${at}.agents`);
    for (const [name, declaration] of ownDataEntries(value.agents, `${at}.agents`)) {
      if (name !== name.trim() || name.length === 0) {
        throw new TypeError(`${at}.agents: agent name ${JSON.stringify(name)} must be a non-empty, trimmed string`);
      }
      const declarationAt = `${at}.agents.${name}`;
      assertHeaderObject(declaration, declarationAt);
      assertKnownKeys(declaration, ["cli", "model"], declarationAt);
      assertRequiredTrimmedString(declaration, "cli", declarationAt);
      assertRequiredTrimmedString(declaration, "model", declarationAt);
    }
  }
}

/**
 * Reads every own property of `value` via its descriptor rather than
 * `Object.entries`/property access, so an accessor (getter) property is
 * REJECTED — never invoked — instead of being enumerated as if it were
 * ordinary data. `Object.entries` would call the getter, and a stateful
 * getter can legally answer validation with one value and a second,
 * unvalidated read (e.g. during freezing) with a different one — the closed
 * declaration contract must not depend on a property being well-behaved
 * across two separate reads.
 */
function ownDataEntries(
  value: Record<string, unknown>,
  at: string,
): [string, unknown][] {
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${at}: unknown field ${JSON.stringify(String(key))}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${at}.${key}: expected a data property`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
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

/**
 * Requires a trimmed, non-empty string — not merely non-empty-after-trim.
 * The SDK's own project-config schema only accepts already-trimmed model/cli
 * strings (`readProjectConfig`, cli/check.ts); accepting untrimmed values
 * here would let a flow author declare " claude " and have it validate at
 * authoring time but fail later at f.agent preflight, moving a defect from
 * authoring to execution instead of catching it up front.
 */
function assertRequiredTrimmedString(
  value: Record<string, unknown>,
  key: string,
  at: string,
): void {
  if (typeof value[key] !== "string" || value[key].length === 0) {
    throw new TypeError(`${at}.${key}: expected a non-empty string`);
  }
  if (value[key] !== value[key].trim()) {
    throw new TypeError(`${at}.${key}: must not have leading or trailing whitespace`);
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
