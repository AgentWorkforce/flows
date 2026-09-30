import type { ScheduleTriggerSource } from "./schedule.js";

const ARRAY_IS_ARRAY = Array.isArray;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const REFLECT_OWN_KEYS = Reflect.ownKeys;

export type WebhookValue = null | boolean | number | string
  | readonly WebhookValue[] | { readonly [key: string]: WebhookValue };

/** Recursive object subset; array and scalar leaves match exactly. */
export type WebhookFilter = { readonly [key: string]: WebhookValue };

export interface WebhookTriggerSource {
  readonly kind: "webhook";
  readonly name: string;
  readonly filter?: WebhookFilter;
}

/** A webhook inbox subscription, or a `schedule.*` tick subscription. */
export type TriggerSource = WebhookTriggerSource | ScheduleTriggerSource;

/** Plain, immutable data. Constructing a source opens no receiver. */
export function webhook(name: string, filter?: WebhookFilter): WebhookTriggerSource {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name)) {
    throw new TypeError("webhook name must be 1-128 letters, digits, underscores or hyphens, starting with a letter or digit");
  }
  if (filter === undefined) return OBJECT_FREEZE({ kind: "webhook", name });
  if (filter === null || typeof filter !== "object" || ARRAY_IS_ARRAY(filter)) {
    throw new TypeError("webhook filter must be a JSON object");
  }
  return OBJECT_FREEZE({ kind: "webhook", name, filter: snapshot(filter) as WebhookFilter });
}

function snapshot(value: unknown, ancestors = new Set<object>()): WebhookValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null || ancestors.has(value)) {
    throw new TypeError("webhook filter must contain finite, acyclic JSON data");
  }
  const array = ARRAY_IS_ARRAY(value);
  if (!array && OBJECT_GET_PROTOTYPE_OF(value) !== Object.prototype && OBJECT_GET_PROTOTYPE_OF(value) !== null) {
    throw new TypeError("webhook filter must contain plain JSON objects");
  }
  ancestors.add(value);
  const entries: [string, WebhookValue][] = [];
  const keys = REFLECT_OWN_KEYS(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    if (array && key === "length") continue;
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("webhook filter must contain JSON data properties");
    }
    if (array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new TypeError("invalid JSON array property");
    OBJECT_DEFINE_PROPERTY(entries, entries.length, {
      configurable: true,
      enumerable: true,
      value: [key, snapshot(descriptor.value, ancestors)],
      writable: true,
    });
  }
  ancestors.delete(value);
  if (array && entries.length !== value.length) throw new TypeError("webhook filter arrays must not be sparse");
  const result: WebhookValue[] | Record<string, WebhookValue> = array ? [] : {};
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const key = entry[0];
    const item = entry[1];
    OBJECT_DEFINE_PROPERTY(result, array ? Number(key) : key, {
      configurable: true,
      enumerable: true,
      value: item,
      writable: true,
    });
  }
  return OBJECT_FREEZE(result);
}
