import { jsonSchemaError } from './json-schema.js';

/** JSON Schema accepted by the `output` authoring declaration. */
export type JsonOutputSchema = Record<string, unknown>;

/** Validate authoring sugar before it can be compiled or submitted. */
export function validateOutputDeclaration(
  step: { output?: unknown; verification?: unknown },
  at: string,
): string[] {
  if (step.output === undefined) return [];
  const errors: string[] = [];
  if (!isObject(step.output)) {
    errors.push(`${at}.output: expected a JSON Schema object`);
  } else {
    // `output` lowers to a `json_schema` gate at compile time, so it must clear
    // exactly the gate a hand-written `verification: {type: json_schema}` does.
    // Without this the kernel refuses at `run.start` a declaration `flows check`
    // had just reported as a gate — the divergence this PR exists to close.
    const invalid = jsonSchemaError(step.output);
    if (invalid !== undefined) {
      errors.push(`${at}.output: invalid JSON Schema: ${invalid}`);
    }
  }
  if (step.verification !== undefined) {
    errors.push(`${at}: output already declares json_schema verification; remove verification`);
  }
  return errors;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
