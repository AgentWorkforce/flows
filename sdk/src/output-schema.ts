/** Type-only marker carried by authoring schemas and erased at runtime. */
declare const outputSchemaType: unique symbol;

/**
 * JSON Schema with a TypeScript-only output type. The symbol property is
 * optional and never exists in emitted specs, so ordinary JSON Schema objects
 * remain the authoring value while TypeScript gates can recover `TOutput`.
 */
export interface JsonOutputSchema<TOutput = unknown> extends Record<string, unknown> {
  readonly [outputSchemaType]?: TOutput;
}

/** Recover the parsed value type carried by a {@link JsonOutputSchema}. */
export type OutputFromSchema<TSchema extends JsonOutputSchema> =
  TSchema extends JsonOutputSchema<infer TOutput> ? TOutput : never;

/** Validate authoring sugar before it can be compiled or submitted. */
export function validateOutputDeclaration(
  step: { output?: unknown; verification?: unknown },
  at: string,
): string[] {
  if (step.output === undefined) return [];
  const errors: string[] = [];
  if (!isObject(step.output)) {
    errors.push(`${at}.output: expected a JSON Schema object`);
  }
  if (step.verification !== undefined) {
    errors.push(`${at}: output already declares json_schema verification; remove verification`);
  }
  return errors;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
