import ts from 'typescript';
import { staticArrayElementCandidates } from './shipped-source-static-call-arguments.js';
import { callableArgumentCandidates } from './shipped-source-callable-invocations.js';
import { referencesGlobalMember } from './shipped-source-global-provenance.js';

function argumentCandidates(
  expression: ts.Expression,
  args: readonly ts.Expression[],
  checker: ts.TypeChecker,
  depth: number,
): Array<readonly ts.Expression[]> {
  if (depth > 8) return [[...args]];
  const candidates = callableArgumentCandidates(
    expression,
    args,
    (expression, currentChecker, seen) => referencesGlobalMember(
      expression,
      'Reflect',
      'apply',
      currentChecker,
      seen,
    ),
    checker,
  );
  for (const candidate of [...candidates]) {
    const target = candidate[0];
    const applied = candidate[2];
    if (!target || !applied) continue;
    for (const values of staticArrayElementCandidates(applied, checker, new Set())) {
      candidates.push(...argumentCandidates(
        target,
        values.values.filter((value): value is ts.Expression => value !== undefined),
        checker,
        depth + 1,
      ));
    }
  }
  return candidates;
}

export function reflectApplyArgumentCandidates(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): Array<readonly ts.Expression[]> {
  return argumentCandidates(node.expression, node.arguments, checker, 0);
}
