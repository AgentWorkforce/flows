import ts from 'typescript';
import { staticArrayElementCandidates } from './shipped-source-static-call-arguments.js';
import { callableArgumentCandidates } from './shipped-source-callable-invocations.js';
import { referencesGlobalMember } from './shipped-source-global-provenance.js';
import { referencesIntrinsicMember } from './shipped-source-intrinsic-members.js';

type Intrinsic = 'Object' | 'Reflect';

function invocationArguments(
  expression: ts.Expression,
  args: readonly ts.Expression[],
  intrinsic: Intrinsic,
  name: string,
  checker: ts.TypeChecker,
  depth: number,
): Array<readonly ts.Expression[]> {
  if (depth > 8) return [];
  const candidates = callableArgumentCandidates(
    expression,
    args,
    (candidate, currentChecker, seen) => referencesIntrinsicMember(
      candidate,
      intrinsic,
      name,
      currentChecker,
      seen,
    ),
    checker,
  );
  const reflected = callableArgumentCandidates(
    expression,
    args,
    (candidate, currentChecker, seen) => referencesGlobalMember(
      candidate,
      'Reflect',
      'apply',
      currentChecker,
      seen,
    ),
    checker,
  );
  for (const reflectArgs of reflected) {
    const target = reflectArgs[0];
    if (!target || !reflectArgs[2]) continue;
    for (const applied of staticArrayElementCandidates(reflectArgs[2], checker, new Set())) {
      candidates.push(...invocationArguments(
        target,
        applied.values.filter((value): value is ts.Expression => value !== undefined),
        intrinsic,
        name,
        checker,
        depth + 1,
      ));
    }
  }
  return candidates;
}

export function intrinsicInvocationArgumentCandidates(
  node: ts.CallExpression,
  intrinsic: Intrinsic,
  name: string,
  checker: ts.TypeChecker,
): Array<readonly ts.Expression[]> {
  return invocationArguments(node.expression, node.arguments, intrinsic, name, checker, 0);
}
