import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const examples = join(__dirname, '..', '..', 'testdata', 'next-examples');
const readExample = (name: string) => readFileSync(join(examples, name), 'utf8');

async function validate(markdown: string, paths: readonly string[]) {
  const validator = await import('../src/next-validator.js');
  return validator.validateNextWorkPackage(markdown, (path) => paths.includes(path));
}

describe('next-validator', () => {
  it('refuses the PR #19/#35 pattern: a passing-test claim without captured output', async () => {
    expect(
      await validate(readExample('uncaptured-test-claim.md'), [
        'sdk/src/next-validator.ts',
      ]),
    ).toEqual({ accepted: false, reason: 'uncaptured_test_claim' });
  });

  it('refuses the nonexistent ops/TARGET.md path pattern', async () => {
    expect(await validate(readExample('nonexistent-path.md'), [])).toEqual({
      accepted: false,
      reason: 'nonexistent_path_reference',
    });
  });

  it('accepts a NEXT.md with real paths and captured command output', async () => {
    expect(
      await validate(readExample('well-formed.md'), [
        'sdk/src/next-validator.ts',
        'sdk/tests/next-validator.test.ts',
      ]),
    ).toEqual({ accepted: true });
  });
});
