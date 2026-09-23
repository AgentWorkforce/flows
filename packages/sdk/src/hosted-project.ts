import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const EXISTS_SYNC = existsSync;
const PATH_DIRNAME = dirname;
const PATH_JOIN = join;
const PATH_RESOLVE = resolve;

/** Project discovery for hosted authority, captured before authored code runs. */
export function findHostedProject(start: string): string | undefined {
  let current = PATH_RESOLVE(start);
  for (;;) {
    if (EXISTS_SYNC(PATH_JOIN(current, 'flows.json'))) return current;
    const parent = PATH_DIRNAME(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
