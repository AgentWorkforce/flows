import { RE2JS } from 're2js';
import type { NamedDataGate, VerificationSpec } from './spec.js';

export const NAMED_GATE_FAILURE_KINDS = [
  'unknown_gate_kind', 'gate_pattern_invalid', 'gate_command_missing', 'gate_bound_invalid',
] as const;
export type NamedGateFailureKind = typeof NAMED_GATE_FAILURE_KINDS[number];

export const NAMED_GATE_KEYS: Record<NamedDataGate['type'], readonly string[]> = {
  references_input: ['type', 'input_key', 'in_output_at'],
  subprocess_gate: ['type', 'command', 'from_output'],
  word_count_bounds: ['type', 'min', 'max'],
  regex_match: ['type', 'pattern', 'in_output_at', 'flags'],
};

export function isNamedGate(gate: VerificationSpec | undefined): gate is NamedDataGate {
  return gate !== undefined && Object.hasOwn(NAMED_GATE_KEYS, gate.type);
}

export function regexFlags(flags: string): number {
  return (flags.includes('i') ? RE2JS.CASE_INSENSITIVE : 0)
    | (flags.includes('m') ? RE2JS.MULTILINE : 0)
    | (flags.includes('s') ? RE2JS.DOTALL : 0);
}

/** Called only on snapshotted data, including by the public validator. */
export function namedGateErrors(gate: Record<string, unknown>, input: unknown, at: string): string[] {
  const errors: string[] = [];
  for (const key of ['in_output_at', 'from_output']) {
    const path = gate[key];
    if (path !== undefined && (!Array.isArray(path) || !path.every(segment =>
      typeof segment === 'string' || (Number.isSafeInteger(segment) && (segment as number) >= 0)))) {
      errors.push(`${at}.${key}: expected an array of object keys or non-negative integer indices`);
    }
  }
  switch (gate.type) {
    case 'references_input':
      if (typeof gate.input_key !== 'string' || !gate.input_key.trim()
        || input === null || typeof input !== 'object' || !Object.hasOwn(input, gate.input_key)) {
        errors.push(`${at}.input_key: must name a declared input binding`);
      }
      break;
    case 'subprocess_gate':
      if (typeof gate.command !== 'string' || !gate.command.trim() || gate.command.includes('\0')) {
        errors.push(`${at}.command: gate_command_missing: expected a non-empty shell command`);
      }
      break;
    case 'word_count_bounds': {
      const { min, max } = gate;
      if ([min, max].some(n => n !== undefined && (!Number.isSafeInteger(n) || (n as number) < 0))
        || (typeof min === 'number' && typeof max === 'number' && min > max)) {
        errors.push(`${at}: gate_bound_invalid: min and max must be non-negative safe integers with min <= max`);
      }
      break;
    }
    case 'regex_match':
      try {
        if (typeof gate.pattern !== 'string' || gate.pattern.length > 8192) {
          throw new Error('pattern must be a string of at most 8192 characters');
        }
        const flags = gate.flags ?? '';
        if (typeof flags !== 'string' || !/^(?!.*(.).*\1)[ims]*$/.test(flags)) {
          throw new Error('flags must be a non-repeating subset of i, m, s');
        }
        RE2JS.compile(gate.pattern, regexFlags(flags));
      } catch (error) {
        errors.push(`${at}: gate_pattern_invalid: ${error instanceof Error ? error.message : 'invalid RE2 pattern'}`);
      }
      break;
  }
  return errors;
}

export function namedGateFailure(errors: readonly string[]): NamedGateFailureKind | undefined {
  return NAMED_GATE_FAILURE_KINDS.find(kind => errors.some(error => error.includes(`${kind}:`)));
}
