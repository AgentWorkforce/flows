import { existsSync } from 'node:fs';

const TEST_CLAIM =
  /\b(?:all\s+)?(?:(?:\d+|all|every|the)\s+)?tests?(?:\s+(?:are|is))?\s+(?:pass(?:ed|ing)?|green)\b|\ball\s+(?:merged\s+and\s+)?tested\b/i;
const INLINE_CODE = /`([^`\n]+)`/g;
const REPO_PATH = /^(?:\.?[A-Za-z0-9_-][A-Za-z0-9._-]*\/)+[A-Za-z0-9._-]+\/?$/;

export type NextValidationRefusalReason =
  | 'uncaptured_test_claim'
  | 'nonexistent_path_reference';

export type NextValidationResult =
  | { accepted: true }
  | { accepted: false; reason: NextValidationRefusalReason };

export type PathExists = (path: string) => boolean;

const defaultPathExists: PathExists = (path) => existsSync(path);

/** Refuse recurring, cheaply provable defects in a NEXT.md work package. */
export function validateNextWorkPackage(
  markdown: string,
  pathExists: PathExists = defaultPathExists,
): NextValidationResult {
  if (hasUncapturedTestClaim(markdown)) {
    return { accepted: false, reason: 'uncaptured_test_claim' };
  }
  if (referencedPaths(markdown).some((path) => !pathExists(path))) {
    return { accepted: false, reason: 'nonexistent_path_reference' };
  }
  return { accepted: true };
}

function hasUncapturedTestClaim(markdown: string): boolean {
  const lines = markdown.split('\n');
  return lines.some((line, index) => {
    if (!TEST_CLAIM.test(line)) return false;
    const nearby = lines.slice(Math.max(0, index - 8), index + 9).join('\n');
    return !containsCapturedCommandOutput(nearby);
  });
}

function containsCapturedCommandOutput(markdown: string): boolean {
  for (const match of markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    const lines = (match[1] ?? '').trim().split('\n');
    const command = lines.findIndex((line) => /^\s*\$\s*\S/.test(line));
    if (command >= 0 && lines.slice(command + 1).some((line) => line.trim().length > 0)) {
      return true;
    }
  }
  return false;
}

function referencedPaths(markdown: string): string[] {
  return [...markdown.matchAll(INLINE_CODE)]
    .map((match) => match[1] ?? '')
    .filter((candidate) => REPO_PATH.test(candidate));
}
