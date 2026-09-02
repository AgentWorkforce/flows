import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CheckFailureKind } from './failure-kinds.js';

export class DirectInputError extends Error {
  constructor(readonly kind: CheckFailureKind, message: string) {
    super(message);
    this.name = 'DirectInputError';
  }
}

/** Parse a direct-run input as an existing JSON file, otherwise as inline JSON. */
export function parseDirectInput(argument: string | undefined): unknown {
  if (argument === undefined) {
    throw new DirectInputError(
      'input_missing',
      'A directly run .flow.ts requires --input <inline-json-or-file>.',
    );
  }

  const inputPath = resolve(argument);
  let source = argument;
  let fromFile = false;
  try {
    const stat = statSync(inputPath);
    if (!stat.isFile()) {
      throw new DirectInputError('input_unreadable', `Input file "${argument}" is not a regular file.`);
    }
    try {
      source = readFileSync(inputPath, 'utf8');
      fromFile = true;
    } catch {
      throw new DirectInputError('input_unreadable', `Input file "${argument}" is not readable.`);
    }
  } catch (error) {
    if (error instanceof DirectInputError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new DirectInputError('input_unreadable', `Input file "${argument}" could not be inspected.`);
    }
  }

  try {
    return JSON.parse(source) as unknown;
  } catch {
    const sourceKind = fromFile ? `Input file "${argument}"` : 'Inline input';
    throw new DirectInputError('input_invalid', `${sourceKind} is not valid JSON.`);
  }
}

export function isAuthoredFlowPath(path: string): boolean {
  return /\.flow\.(?:ts|mts|js|mjs)$/.test(path);
}
