import type { ScheduleTriggerSource } from "./schedule.js";

const ARRAY_IS_ARRAY = Array.isArray;
const NUMBER_IS_FINITE = Number.isFinite.bind(Number);
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const MAX_ARRAY_INDEX = "4294967294";

function isArrayIndexKey(key: string): boolean {
  if (key === "0") return true;
  if (key.length === 0 || key[0]! < "1" || key[0]! > "9") return false;
  for (let index = 1; index < key.length; index += 1) {
    if (key[index]! < "0" || key[index]! > "9") return false;
  }
  return key.length < MAX_ARRAY_INDEX.length
    || (key.length === MAX_ARRAY_INDEX.length && key <= MAX_ARRAY_INDEX);
}

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
  if (typeof value === "number" && NUMBER_IS_FINITE(value)) return value;
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
    if (array && !isArrayIndexKey(key)) throw new TypeError("invalid JSON array property");
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
    OBJECT_DEFINE_PROPERTY(result, key, {
      configurable: true,
      enumerable: true,
      value: item,
      writable: true,
    });
  }
  return OBJECT_FREEZE(result);
}
