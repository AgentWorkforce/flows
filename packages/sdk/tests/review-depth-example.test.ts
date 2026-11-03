import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('validates review metadata and enforces size and sensitive-file floors', () => {
  const source = readFileSync(resolve('../../examples/classify/review-policy.ts'), 'utf8');
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
  const module = 'data:text/javascript;base64,' + Buffer.from(javascript).toString('base64');
  const script = `
    import assert from 'node:assert/strict';
    import { reviewInput, reviewDepth } from ${JSON.stringify(module)};
    const change = { summary: 'diff', paths: ['README.md'], changedLines: 1 };
    for (const input of [null, {}, { ...change, paths: null }, { ...change, paths: [1] },
      { ...change, changedLines: -1 }, { ...change, changedLines: NaN },
      { ...change, changedLines: Infinity }, { ...change, changedLines: '500' }]) {
      assert.throws(() => reviewInput(input), TypeError);
    }
    assert.deepEqual(reviewInput(change), change);
    for (const path of ['src/auth.ts', 'lib/security.ts', 'db/migrations.sql', 'kernel/src/lib.rs']) {
      assert.equal(reviewDepth({ ...change, paths: [path] }, 'small'), 'deep');
    }
    assert.equal(reviewDepth({ ...change, changedLines: 500 }, 'small'), 'deep');
    assert.equal(reviewDepth({ ...change, changedLines: 100 }, 'small'), 'standard');
    assert.equal(reviewDepth(change, 'small'), 'small');
    assert.equal(reviewDepth(change, 'deep'), 'deep');
    console.log('REVIEW_POLICY_OK');
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  expect(output).toContain('REVIEW_POLICY_OK');
});
