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
  }
  if (step.verification !== undefined) {
    errors.push(`${at}: output already declares json_schema verification; remove verification`);
  }
  return errors;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
