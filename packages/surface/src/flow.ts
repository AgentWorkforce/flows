import { helperProviders } from "./helpers/providers.js";
import type { Helpers } from "./helpers/index.js";
type HelperTools = Partial<Record<keyof Helpers, boolean>>;
import type { Ctx } from "./context.js";
import { webhook, type TriggerSource } from "./triggers.js";

/** Optional escalation header; the empty header is the common case. */
export interface FlowHeader {
  /** Relative paths to reusable authored flows composed by this body. */
  use?: string[];
  identity?: string;
  memory?: { script?: boolean; agent?: boolean };
  budget?: string | { tokens?: number; dollars?: number; wallclock?: string };
  tools?: HelperTools & { relayfile?: string[]; mcp?: string[] };
  workspace?: string;
}

export type FlowBody<Input = unknown> = (f: Ctx, input: Input) => Promise<void>;

export interface ReadonlyFlowHeader {
  readonly use?: readonly string[];
  readonly identity?: string;
  readonly memory?: Readonly<{ script?: boolean; agent?: boolean }>;
  readonly budget?: string | Readonly<{ tokens?: number; dollars?: number; wallclock?: string }>;
  readonly tools?: Readonly<HelperTools & {
    slack?: boolean;
    relayfile?: readonly string[];
    mcp?: readonly string[];
  }>;
  readonly workspace?: string;
}

/** Immutable definition retained for the SDK's journal-backed runtime. */
export interface AuthoredFlowDefinition<Input = unknown> {
  readonly name: string;
  readonly header: ReadonlyFlowHeader;
  readonly body: FlowBody<Input>;
  readonly handlers: readonly TriggerHandler[];
}

export interface TriggerHandler {
  readonly trigger: TriggerSource;
  readonly body: FlowBody;
}

/** Opaque authored-flow handle. Execution stays behind the journal runtime. */
export interface FlowHandle {
  readonly name: string;
  on<Event = Record<string, unknown>>(trigger: TriggerSource, body: FlowBody<Event>): TriggeredFlowHandle;
}

export interface TriggeredFlowHandle extends FlowHandle {}

const definitions = new WeakMap<object, AuthoredFlowDefinition>();

export function flow(name: string, header?: FlowHeader): FlowHandle;
export function flow<Input = unknown>(name: string, body: FlowBody<Input>): FlowHandle;
export function flow<Input = unknown>(
  name: string,
  header: FlowHeader,
  body: FlowBody<Input>,
): FlowHandle;
export function flow<Input = unknown>(
  name: string,
  headerOrBody: FlowHeader | FlowBody<Input> = {},
  body?: FlowBody<Input>,
): FlowHandle {
  const flowBody = typeof headerOrBody === "function" ? headerOrBody : body;
  const header = typeof headerOrBody === "function" ? {} : headerOrBody;

  if (name.trim().length === 0) {
    throw new TypeError("flow name must not be empty");
  }
  if (flowBody !== undefined && typeof flowBody !== "function") {
    throw new TypeError(`flow "${name}" requires a body`);
  }
  assertFlowHeader(header, name);

  const definition: AuthoredFlowDefinition<Input> = Object.freeze({
    name,
    header: freezeHeader(header),
    body: flowBody ?? (async () => { throw new TypeError(`flow "${name}" has no direct-run body`); }),
    handlers: Object.freeze([]),
  });
  return makeHandle(definition as AuthoredFlowDefinition);
}

function makeHandle(definition: AuthoredFlowDefinition): FlowHandle {
  const handle = { name: definition.name } as FlowHandle;
  Object.defineProperty(handle, "on", {
    value: <Event>(trigger: TriggerSource, body: FlowBody<Event>): TriggeredFlowHandle => {
      if (typeof body !== "function") throw new TypeError("trigger handler requires a body");
      assertHeaderObject(trigger, "trigger");
      assertKnownKeys(trigger, ["kind", "name", "filter"], "trigger");
      if (trigger.kind !== "webhook") throw new TypeError("unsupported trigger kind");
      const source = webhook(trigger.name, trigger.filter);
      return makeHandle(Object.freeze({
        ...definition,
        handlers: Object.freeze([...definition.handlers, Object.freeze({ trigger: source, body: body as FlowBody })]),
      }));
    },
  });
  Object.freeze(handle);
  // One map holds definitions of many input types, so it is stored at the
  // default parameterisation and `getFlowDefinition<Input>` re-parameterises on
  // the way out. The cast is needed because `body` puts `Input` in a parameter
  // position, making the type invariant: `AuthoredFlowDefinition<Input>` is not
  // assignable to `AuthoredFlowDefinition<unknown>` even though every read
  // recovers the author's own type. Sound here because the handle-to-definition
  // pairing is 1:1 and both sides are keyed by the same authored flow.
  definitions.set(handle, definition);
  return handle;
}

/**
 * Runtime bridge used by the SDK after it imports an authored `.flow.ts`.
 * The root package deliberately does not re-export this accessor.
 */
export function getFlowDefinition<Input = unknown>(handle: Pick<FlowHandle, "name">): AuthoredFlowDefinition<Input> {
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
  const unknownFields = Object.keys(header).filter((field) => ![
    "use",
    "identity",
    "memory",
    "budget",
    "tools",
    "workspace",
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
        ...Object.fromEntries(helperProviders.filter(p => header.tools?.[p.namespace] !== undefined)
          .map(p => [p.namespace, header.tools![p.namespace]])),
        ...(header.tools.relayfile === undefined
          ? {}
          : { relayfile: Object.freeze([...header.tools.relayfile]) }),
        ...(header.tools.mcp === undefined
          ? {}
          : { mcp: Object.freeze([...header.tools.mcp]) }),
      });
  return Object.freeze({
    ...(header.use === undefined ? {} : { use: Object.freeze([...header.use]) }),
    ...(header.identity === undefined ? {} : { identity: header.identity }),
    ...(memory === undefined ? {} : { memory }),
    ...(header.budget === undefined ? {} : { budget: typeof header.budget === "string" ? header.budget : Object.freeze({ ...header.budget }) }),
    ...(tools === undefined ? {} : { tools }),
    ...(header.workspace === undefined ? {} : { workspace: header.workspace }),
  });
}

function assertFlowHeader(value: unknown, flowName: string): asserts value is FlowHeader {
  const at = `unsupported_header: flow "${flowName}" header`;
  assertHeaderObject(value, at);
  assertKnownKeys(
    value,
    ["use", "identity", "memory", "budget", "tools", "workspace"],
    at,
  );
  assertOptionalString(value, "identity", at);
  if (value.budget !== undefined && typeof value.budget !== "string") {
    assertHeaderObject(value.budget, `${at}.budget`);
    assertKnownKeys(value.budget, ["tokens", "dollars", "wallclock"], `${at}.budget`);
    assertOptionalString(value.budget, "wallclock", at);
    for (const key of ["tokens", "dollars"]) {
      if (value.budget[key] !== undefined && typeof value.budget[key] !== "number") throw new TypeError(`budget_syntax_invalid: ${key} must be a number`);
    }
  }
  assertOptionalString(value, "workspace", at);
  assertOptionalStringArray(value, "use", at);
  if (value.use !== undefined) {
    for (const path of value.use as string[]) {
      if (!/^(?:\.\/|\.\.\/).+\.flow\.ts$/.test(path) || /[?#\\\\]/.test(path)) {
        throw new TypeError(`${at}.use: expected relative .flow.ts paths`);
      }
    }
  }

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
      ["relayfile", "mcp", ...helperProviders.map(p => p.namespace)],
      `${at}.tools`,
    );
    for (const { namespace } of helperProviders) assertOptionalBoolean(value.tools, namespace, `${at}.tools`);
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
    && (!Array.isArray(candidate) || Array.from(candidate).some((item) => typeof item !== "string"))
  ) {
    throw new TypeError(`${at}.${key}: expected an array of strings`);
  }
  if (key === "use" && Array.isArray(candidate)
    && (candidate.some((item) => item.trim().length === 0)
      || new Set(candidate).size !== candidate.length)) {
    throw new TypeError(`${at}.${key}: expected unique nonempty paths`);
  }
}
