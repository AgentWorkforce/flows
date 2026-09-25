import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CheckFailureKind } from './failure-kinds.js';

export const MAX_DIRECT_INPUT_BYTES = 1_048_576;

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
    if (stat.size > MAX_DIRECT_INPUT_BYTES) {
      throw tooLarge(argument, true);
    }
    try {
      source = readFileSync(inputPath, 'utf8');
      fromFile = true;
    } catch {
      throw new DirectInputError('input_unreadable', `Input file "${argument}" is not readable.`);
    }
  } catch (error) {
    if (error instanceof DirectInputError) throw error;
    if (!namesNoFile(error)) {
      throw new DirectInputError('input_unreadable', `Input file "${argument}" could not be inspected.`);
    }
  }

  if (!fromFile && Buffer.byteLength(source, 'utf8') > MAX_DIRECT_INPUT_BYTES) {
    throw tooLarge(argument, false);
  }

  try {
    return JSON.parse(source) as unknown;
  } catch {
    const sourceKind = fromFile ? `Input file "${argument}"` : 'Inline input';
    throw new DirectInputError('input_invalid', `${sourceKind} is not valid JSON.`);
  }
}

/**
 * Whether the `stat` failed because the argument names no file at all, rather
 * than because a file exists and could not be inspected.
 *
 * `ENOENT` is the ordinary "nothing there". `ENAMETOOLONG` is the same answer
 * for a longer argument: no path component may exceed the filesystem's limit
 * (255 bytes on ext4 and on APFS), so an inline JSON object of a few hundred
 * bytes cannot be a filename on any filesystem this runs on. Calling that
 * `input_unreadable` refused every inline input longer than a filename — the
 * recorded-input recovery commands `cli/local-agent-remedy.ts` prints for a
 * parked run among them, which is how it was found.
 *
 * Anything else — a permission error, an I/O error — still refuses, because it
 * means a path is there and this process could not look at it. Guessing that
 * such an argument was inline JSON would parse a filename as a document.
 */
function namesNoFile(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENAMETOOLONG';
}

function tooLarge(argument: string, fromFile: boolean): DirectInputError {
  const sourceKind = fromFile ? `Input file "${argument}"` : 'Inline input';
  return new DirectInputError(
    'input_too_large',
    `${sourceKind} exceeds the ${MAX_DIRECT_INPUT_BYTES}-byte direct input limit.`,
  );
}

export function isAuthoredFlowPath(path: string): boolean {
  return /\.flow\.(?:ts|mts|js|mjs)$/.test(path);
}
