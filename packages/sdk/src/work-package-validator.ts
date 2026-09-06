import { existsSync } from 'node:fs';

export type NextWorkPackageRefusalReason =
  | 'nonexistent_repo_path'
  | 'test_claim_without_evidence';

export type NextWorkPackageValidation =
  | { accepted: true }
  | { accepted: false; reason: NextWorkPackageRefusalReason };

/** Resolve a referenced path. Injectable so validation is deterministic in tests. */
export type WorkPackagePathExists = (path: string) => boolean;

const defaultPathExists: WorkPackagePathExists = (path) => existsSync(path);
const INLINE_CODE = /(?<!`)`([^`\n]+)`(?!`)/g;
const REPO_PATH = /^[A-Za-z_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)+$/;
const TEST_RESULT_CLAIM =
  /(?:\b(?:all|both|one|two|three|four|five|six|seven|eight|nine|ten|\d+|tests?|test suite|checks?|build)\b[^\n]{0,60}\b(?:green|pass(?:ed|es|ing)?|succeed(?:ed|s)?|tested)\b|\b(?:is|are|was|were|has been|have been)\b[^\n]{0,60}\btested\b)/i;

/**
 * Validate claims and repository references in an ops/NEXT.md work package.
 * Refusals are values so a caller cannot mistake an unchecked package for work.
 */
export function validateNextWorkPackage(
  markdown: string,
  pathExists: WorkPackagePathExists = defaultPathExists,
): NextWorkPackageValidation {
  for (const path of referencedRepoPaths(markdown)) {
    if (!pathExists(path)) return { accepted: false, reason: 'nonexistent_repo_path' };
  }

  const lines = markdown.split(/\r?\n/);
  const fencedLines = findFencedLines(lines);
  for (const [index, line] of lines.entries()) {
    if (fencedLines.has(index) || !TEST_RESULT_CLAIM.test(line)) continue;
    // A REQUIREMENT is not a CLAIM. "npm test must be green" states what has to
    // become true; "All three tests pass" asserts it already is. Only the
    // second needs evidence (review, PR #50).
    //
    // The discriminator is MODALITY, not location. A first attempt at this
    // exempted every line under a "Definition of done" heading, which let the
    // PR #19 artifact through — its claim "All three tests pass." sits under
    // exactly that heading and is precisely what this must catch.
    //
    // The modal check was already here but keyed only on "pass", so "must be
    // green" and "must be clean" still tripped it.
    if (/\b(?:must|should|will|needs? to|has to)\b[^\n]{0,40}\b(?:pass|passing|green|clean|succeed)\b/i.test(line)) {
      continue;
    }
    if (!hasNearbyTranscript(lines, fencedLines, index)) {
      return { accepted: false, reason: 'test_claim_without_evidence' };
    }
  }
  return { accepted: true };
}

function referencedRepoPaths(markdown: string): string[] {
  return [...markdown.matchAll(INLINE_CODE)]
    .map((match) => match[1] ?? '')
    .filter((candidate) => REPO_PATH.test(candidate));
}

function findFencedLines(lines: string[]): Set<number> {
  const fenced = new Set<number>();
  let open = false;
  for (const [index, line] of lines.entries()) {
    if (/^\s*```/.test(line)) {
      fenced.add(index);
      open = !open;
    } else if (open) {
      fenced.add(index);
    }
  }
  return fenced;
}

function hasNearbyTranscript(lines: string[], fenced: Set<number>, claimIndex: number): boolean {
  const nearby = lines
    .map((line, index) => ({ line, index }))
    .filter(({ index }) => fenced.has(index) && Math.abs(index - claimIndex) <= 10)
    .map(({ line }) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('```'));
  const commandIndex = nearby.findIndex(isCommandLine);
  return commandIndex >= 0 && nearby.some((line, index) => index > commandIndex && !isCommandLine(line));
}

function isCommandLine(line: string): boolean {
  const command = line.startsWith('$ ') ? line.slice(2) : line;
  return /^(?:cd\s+\S+\s*&&\s*)?(?:npm|node|cargo|sh|pnpm|yarn|pytest|go)\b/.test(command);
}
