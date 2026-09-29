import ts from 'typescript';
import { callableArgumentCandidates } from './shipped-source-callable-invocations.js';
import { referencesGlobalMember } from './shipped-source-global-provenance.js';

export function reflectApplyArgumentCandidates(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): Array<readonly ts.Expression[]> {
  return callableArgumentCandidates(
    node.expression,
    node.arguments,
    (expression, currentChecker, seen) => referencesGlobalMember(
      expression,
      'Reflect',
      'apply',
      currentChecker,
      seen,
    ),
    checker,
  );
}
