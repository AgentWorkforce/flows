export type WebhookValue = null | boolean | number | string
  | readonly WebhookValue[] | { readonly [key: string]: WebhookValue };

/** Recursive object subset; array and scalar leaves match exactly. */
export type WebhookFilter = { readonly [key: string]: WebhookValue };

export interface TriggerSource {
  readonly kind: "webhook";
  readonly name: string;
  readonly filter?: WebhookFilter;
}

/** Plain, immutable data. Constructing a source opens no receiver. */
export function webhook(name: string, filter?: WebhookFilter): TriggerSource {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name)) {
    throw new TypeError("webhook name must be 1-128 letters, digits, underscores or hyphens, starting with a letter or digit");
  }
  if (filter === undefined) return Object.freeze({ kind: "webhook", name });
  if (filter === null || typeof filter !== "object" || Array.isArray(filter)) {
    throw new TypeError("webhook filter must be a JSON object");
  }
  return Object.freeze({ kind: "webhook", name, filter: snapshot(filter) as WebhookFilter });
}

function snapshot(value: unknown, ancestors = new Set<object>()): WebhookValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null || ancestors.has(value)) {
    throw new TypeError("webhook filter must contain finite, acyclic JSON data");
  }
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError("webhook filter must contain plain JSON objects");
  }
  ancestors.add(value);
  const entries: [string, WebhookValue][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("webhook filter must contain JSON data properties");
    }
    if (array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new TypeError("invalid JSON array property");
    entries.push([key, snapshot(descriptor.value, ancestors)]);
  }
  ancestors.delete(value);
  if (array && entries.length !== value.length) throw new TypeError("webhook filter arrays must not be sparse");
  return Object.freeze(array ? entries.map(([, item]) => item) : Object.fromEntries(entries));
}
