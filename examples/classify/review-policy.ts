export interface Change {
  summary: string;
  paths: string[];
  changedLines: number;
}
export type ReviewDepth = 'small' | 'standard' | 'deep';

/** Validate JSON metadata before classification or deterministic policy. */
export function reviewInput(input: unknown): Change {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('review-depth requires change metadata');
  }
  const change = input as Partial<Change>;
  if (typeof change.summary !== 'string' || !Array.isArray(change.paths)
    || change.paths.some(path => typeof path !== 'string' || path.trim() === '')
    || typeof change.changedLines !== 'number' || !Number.isSafeInteger(change.changedLines)
    || change.changedLines < 0) {
    throw new TypeError('review-depth requires summary, string paths, and a nonnegative integer changedLines');
  }
  return change as Change;
}

/** Example policy floors. Consumers choose their own thresholds and paths. */
export function reviewDepth(change: Change, choice: ReviewDepth): ReviewDepth {
  const sensitive = change.paths.some(path => /(^|[\/\\])(auth|security|migrations|kernel)([\/\\.]|$)/i.test(path));
  return sensitive || change.changedLines >= 500 ? 'deep'
    : change.changedLines >= 100 && choice === 'small' ? 'standard' : choice;
}
