// Model replies, parsed and checked in author code. The schemas in prompts.ts
// use a small JSON Schema subset; this validates exactly that subset and
// refuses any keyword it does not know, so a schema can never silently weaken.

type Schema = Record<string, unknown>;
const KNOWN = new Set(["type", "required", "properties", "additionalProperties", "items", "minItems", "minLength", "pattern", "enum", "const"]);

/** The reply text as JSON, tolerating one surrounding markdown fence. Throws on anything else. */
export function parseReply(text: string): unknown {
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/.exec(text.trim());
  return JSON.parse(fenced ? fenced[1]! : text.trim());
}

/** The first way `value` violates `schema`, or null. */
export function schemaError(schema: Schema, value: unknown, at = "$"): string | null {
  for (const key of Object.keys(schema)) if (!KNOWN.has(key)) throw new Error(`reply schema keyword "${key}" is not supported`);
  if ("const" in schema && value !== schema.const) return `${at} must be ${JSON.stringify(schema.const)}`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${at} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`;
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") return `${at} must be a string`;
      if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${at} must be at least ${schema.minLength} characters`;
      if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return `${at} must match ${schema.pattern}`;
      return null;
    case "number":
      return typeof value === "number" ? null : `${at} must be a number`;
    case "boolean":
      return typeof value === "boolean" ? null : `${at} must be true or false`;
    case "array": {
      if (!Array.isArray(value)) return `${at} must be an array`;
      if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${at} needs at least ${schema.minItems} item(s)`;
      for (let i = 0; i < value.length; i++) {
        const e = schema.items ? schemaError(schema.items as Schema, value[i], `${at}[${i}]`) : null;
        if (e) return e;
      }
      return null;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return `${at} must be an object`;
      const props = (schema.properties ?? {}) as Record<string, Schema>;
      for (const key of (schema.required ?? []) as string[]) if (!(key in value)) return `${at}.${key} is required`;
      for (const [key, v] of Object.entries(value)) {
        if (!(key in props)) { if (schema.additionalProperties === false) return `${at}.${key} is not allowed`; continue; }
        const e = schemaError(props[key]!, v, `${at}.${key}`);
        if (e) return e;
      }
      return null;
    }
    case undefined:
      return null;
    default:
      throw new Error(`reply schema type "${String(schema.type)}" is not supported`);
  }
}
