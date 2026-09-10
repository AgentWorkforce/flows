import type { OutputBinding } from './spec.js';

/** Input is a closed selector map, never a template or expression language. */
export function inputBindingErrors(steps: readonly unknown[]): string[] {
  const errors: string[] = [];
  const sources = new Map(steps.flatMap((step, index) =>
    isObject(step) && typeof step.id === 'string' ? [[step.id, { step, index }] as const] : []));
  for (const [index, step] of steps.entries()) {
    if (!isObject(step) || step.input === undefined) continue;
    const at = `spec.steps[${index}].input`;
    if (!isObject(step.input)) {
      errors.push(`${at}: expected a map of output selectors`);
      continue;
    }
    for (const [name, binding] of Object.entries(step.input)) {
      const where = `${at}.${name}`;
      if (!name.trim() || !isBinding(binding)) {
        errors.push(`${where}: expected { step: <id>, path?: [object keys or array indices] }`);
        continue;
      }
      const source = sources.get(binding.step);
      if (source === undefined) {
        errors.push(`${where}: unknown source step "${binding.step}"`);
        continue;
      }
      if (source.index >= index) {
        errors.push(`${where}: source "${binding.step}" must precede this step; forward and self references are not supported`);
      }
      const gate = source.step.verification;
      const schema = source.step.output ?? (isObject(gate) && gate.type === 'json_schema' ? gate.schema : undefined);
      if (schema === undefined) {
        errors.push(`${where}: source "${binding.step}" must declare an output schema (output or json_schema verification)`);
      } else if (!declaresPath(schema, binding.path ?? [])) {
        errors.push(`${where}: path ${JSON.stringify(binding.path)} is not present in source "${binding.step}"'s declared output schema`);
      }
    }
  }
  return errors;
}

export function bindingDependencies(input: unknown): string[] {
  return isObject(input) ? Object.values(input).filter(isBinding).map(binding => binding.step) : [];
}

function isBinding(value: unknown): value is OutputBinding {
  return isObject(value)
    && Object.keys(value).every(key => key === 'step' || key === 'path')
    && typeof value.step === 'string' && value.step.trim().length > 0
    && (value.path === undefined || (Array.isArray(value.path) && value.path.every(segment =>
      typeof segment === 'string' || (typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0))));
}

/** Only explicit properties/items paths are portable; no schema inference. */
function declaresPath(schema: unknown, path: readonly (string | number)[]): boolean {
  let current = schema;
  for (const segment of path) {
    if (!isObject(current)) return false;
    if (typeof segment === 'string') {
      if (!isObject(current.properties) || !Object.hasOwn(current.properties, segment)) return false;
      current = current.properties[segment];
    } else if (Array.isArray(current.prefixItems) && segment < current.prefixItems.length) {
      current = current.prefixItems[segment];
    } else if (Array.isArray(current.items)) {
      if (segment >= current.items.length) return false;
      current = current.items[segment];
    } else {
      if (current.items === undefined) return false;
      current = current.items;
    }
  }
  return current !== undefined && current !== false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
