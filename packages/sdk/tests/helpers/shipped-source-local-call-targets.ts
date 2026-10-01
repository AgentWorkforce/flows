import ts from 'typescript';
import {
  assignmentMayStoreRight,
  type BindingPathSegment,
} from './shipped-source-binding-provenance.js';
import {
  aggregateMemberValue,
  staticPropertySegment,
  wrappedExpressionBranches,
} from './shipped-source-binding-values.js';
import {
  bindingNamePaths,
  canonicalArrayIndex,
  isStaticallyUndefined,
  localCallArgumentCandidates,
} from './shipped-source-local-call-arguments.js';
import { returnedExpressions } from './shipped-source-return-values.js';

export interface LocalCallTargetPath {
  path: BindingPathSegment[];
  symbol: ts.Symbol;
}

export interface LocalCallValueResolution {
  candidates: Array<{
    expression: ts.Expression;
    seen: Set<ts.Symbol>;
  }>;
}

type ResolveTargetPaths = (
  expression: ts.Expression,
  seen: Set<ts.Symbol>,
) => LocalCallTargetPath[];

function pathsAtActual(
  actual: ts.Expression,
  sourcePath: readonly BindingPathSegment[],
  suffix: readonly BindingPathSegment[],
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
  resolve: ResolveTargetPaths,
): LocalCallTargetPath[] {
  const selected = valuesAtPath(actual, sourcePath, checker, seen);
  return selected.flatMap(value => [
    ...resolve(value, new Set(seen))
      .map(parent => ({ ...parent, path: [...parent.path, ...suffix] })),
    ...(suffix.length === 0 ? [] : valuesAtPath(value, suffix, checker, seen)
      .flatMap(candidate => resolve(candidate, new Set(seen)))),
  ]);
}

function arrayBindingSelection(
  formalPath: readonly BindingPathSegment[],
  returnedPath: readonly BindingPathSegment[],
  rest: { prefixLength: number; start: number },
): {
  sourcePath: BindingPathSegment[];
  suffix: BindingPathSegment[];
} | undefined {
  const prefix = formalPath.slice(0, rest.prefixLength);
  const relativeFormal = formalPath.slice(rest.prefixLength);
  const formalOffset = relativeFormal[0];
  const returnedOffset = returnedPath[0];
  const relativeOffset = formalOffset ?? returnedOffset;
  if (relativeOffset === undefined) return undefined;
  const index = canonicalArrayIndex(relativeOffset);
  if (index === undefined) return undefined;
  return {
    sourcePath: [
      ...prefix,
      rest.start + index,
      ...(formalOffset === undefined ? [] : relativeFormal.slice(1)),
    ],
    suffix: formalOffset === undefined && returnedOffset !== undefined
      ? [...returnedPath.slice(1)]
      : [...returnedPath],
  };
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
  return expression;
}

function expressionRootPath(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): LocalCallTargetPath | undefined {
  expression = unwrap(expression);
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    return symbol ? { path: [], symbol } : undefined;
  }
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return undefined;
  const parent = expressionRootPath(expression.expression, checker, seen);
  if (!parent) return undefined;
  const segment = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : expression.argumentExpression
      ? staticPropertySegment(expression.argumentExpression, checker, new Set(seen))
      : undefined;
  return segment === undefined ? undefined : { ...parent, path: [...parent.path, segment] };
}

function valuesAtPath(
  expression: ts.Expression,
  path: readonly BindingPathSegment[],
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): ts.Expression[] {
  expression = unwrap(expression);
  if (ts.isCallExpression(expression)) {
    const resolved = localCallValueCandidates(expression, checker, seen, path);
    if (resolved) return resolved.candidates.map(candidate => candidate.expression);
  }
  let values = [expression];
  for (const segment of path) {
    values = values.flatMap(value => {
      const member = aggregateMemberValue(value, segment, checker, new Set(seen));
      return member ? [member.value, ...(member.alternatives ?? [])] : [];
    });
  }
  return values;
}

function valuesAtActual(
  actual: ts.Expression,
  sourcePath: readonly BindingPathSegment[],
  suffix: readonly BindingPathSegment[],
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): ts.Expression[] {
  const selected = valuesAtPath(actual, sourcePath, checker, seen);
  return suffix.length === 0
    ? selected
    : selected.flatMap(value => valuesAtPath(value, suffix, checker, seen));
}

function returnedValueCandidates(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): LocalCallValueResolution['candidates'] {
  expression = unwrap(expression);
  const branches = wrappedExpressionBranches(expression);
  if (branches) return branches.flatMap(branch =>
    returnedValueCandidates(branch, checker, new Set(seen)));
  if (ts.isBinaryExpression(expression) && assignmentMayStoreRight(expression.operatorToken.kind)) {
    const assignments = expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ? [expression.right]
      : [expression.left, expression.right];
    return assignments.flatMap(candidate =>
      returnedValueCandidates(candidate, checker, new Set(seen)));
  }
  if (ts.isCallExpression(expression)) {
    const resolved = localCallValueCandidates(expression, checker, seen);
    if (resolved) return resolved.candidates;
  }
  return [{ expression, seen: new Set(seen) }];
}

function isParameterSymbol(
  declaration: ts.SignatureDeclaration,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  return declaration.parameters.some(parameter =>
    bindingNamePaths(parameter.name, symbol, checker).length > 0);
}

/** Resolve local return expressions to their call actuals for value analysis. */
export function localCallValueCandidates(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
  callerPath: readonly BindingPathSegment[] = [],
): LocalCallValueResolution | undefined {
  const declaration = checker.getResolvedSignature(expression)?.declaration;
  const callee = checker.getSymbolAtLocation(unwrap(expression.expression));
  if (!declaration || !ts.isFunctionLike(declaration) || !('body' in declaration)
    || (callee && seen.has(callee))) return undefined;
  const nextSeen = callee ? new Set(seen).add(callee) : new Set(seen);
  const actualCandidates = localCallArgumentCandidates(expression.arguments, checker);
  const fallbackAtCallerPath = (
    candidate: LocalCallValueResolution['candidates'][number],
  ): LocalCallValueResolution['candidates'] => {
    if (callerPath.length === 0) return [candidate];
    return valuesAtPath(candidate.expression, callerPath, checker, candidate.seen)
      .map(value => ({ expression: value, seen: new Set(candidate.seen) }));
  };
  if (actualCandidates.length === 0) {
    const candidates = returnedExpressions(declaration.body).flatMap(returned =>
      returnedValueCandidates(returned, checker, nextSeen).flatMap(candidate => {
        const root = expressionRootPath(candidate.expression, checker, candidate.seen);
        return root && isParameterSymbol(declaration, root.symbol, checker)
          ? []
          : fallbackAtCallerPath(candidate);
      }));
    return { candidates };
  }
  const candidates = returnedExpressions(declaration.body).flatMap(returned => {
    return returnedValueCandidates(returned, checker, nextSeen).flatMap(returnedCandidate => {
      const returnedMember = expressionRootPath(
        returnedCandidate.expression,
        checker,
        returnedCandidate.seen,
      );
      if (!returnedMember) {
        const selected = valuesAtPath(
          returnedCandidate.expression,
          callerPath,
          checker,
          returnedCandidate.seen,
        );
        return selected.map(candidate => ({
          expression: candidate,
          seen: new Set(returnedCandidate.seen),
        }));
      }
      const returnedPath = [...returnedMember.path, ...callerPath];
      const mapped = declaration.parameters.flatMap((parameter, parameterIndex) =>
        bindingNamePaths(parameter.name, returnedMember.symbol, checker).flatMap(formal =>
          actualCandidates.flatMap(actuals => {
            if (parameter.dotDotDotToken) {
              const selection = arrayBindingSelection(
                formal.path,
                returnedPath,
                formal.rest?.kind === 'array'
                  ? formal.rest
                  : { prefixLength: 0, start: 0 },
              );
              if (!selection) return [];
              const [actualOffset, ...sourcePath] = selection.sourcePath;
              const index = actualOffset === undefined ? undefined : canonicalArrayIndex(actualOffset);
              const actual = index === undefined ? undefined : actuals[parameterIndex + index];
              return actual && !ts.isSpreadElement(actual)
                ? valuesAtActual(actual, sourcePath, selection.suffix, checker, seen)
                  .map(value => ({ expression: value, seen: new Set(seen) }))
                : [];
            }
            const supplied = actuals[parameterIndex];
            const actual = !supplied || isStaticallyUndefined(supplied, checker)
              ? parameter.initializer
              : supplied;
            if (!actual || ts.isSpreadElement(actual)) return [];
            if (formal.rest?.kind === 'array') {
              const selection = arrayBindingSelection(formal.path, returnedPath, formal.rest);
              return selection
                ? valuesAtActual(actual, selection.sourcePath, selection.suffix, checker, seen)
                  .map(value => ({ expression: value, seen: new Set(seen) }))
                : [];
            }
            if (formal.rest?.kind === 'object') {
              const [member, ...suffix] = returnedPath;
              if (member === undefined || formal.rest.excluded.includes(String(member))) return [];
              return valuesAtActual(actual, [...formal.path, member], suffix, checker, seen)
                .map(value => ({ expression: value, seen: new Set(seen) }));
            }
            return valuesAtActual(
              actual,
              formal.path,
              returnedPath,
              checker,
              seen,
            ).map(value => ({ expression: value, seen: new Set(seen) }));
          })));
      return mapped.length > 0 ? mapped : fallbackAtCallerPath(returnedCandidate);
    });
  });
  return { candidates };
}

export function localCallTargetPaths(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
  resolve: ResolveTargetPaths,
  callerPath: readonly BindingPathSegment[] = [],
): LocalCallTargetPath[] {
  const declaration = checker.getResolvedSignature(expression)?.declaration;
  const callee = checker.getSymbolAtLocation(unwrap(expression.expression));
  if (!declaration || !ts.isFunctionLike(declaration) || !('body' in declaration)
    || (callee && seen.has(callee))) return [];
  const nextSeen = callee ? new Set(seen).add(callee) : new Set(seen);
  const actualCandidates = localCallArgumentCandidates(expression.arguments, checker);
  if (actualCandidates.length === 0) {
    return returnedExpressions(declaration.body).flatMap(returned =>
      resolve(returned, new Set(nextSeen)).flatMap(returnedMember =>
        isParameterSymbol(declaration, returnedMember.symbol, checker)
          ? []
          : [{ ...returnedMember, path: [...returnedMember.path, ...callerPath] }]));
  }
  return actualCandidates.flatMap(actuals => returnedExpressions(declaration.body).flatMap(returned =>
    resolve(returned, new Set(nextSeen)).flatMap(returnedMember => {
      const returnedPath = [...returnedMember.path, ...callerPath];
      const mapped = declaration.parameters.flatMap((parameter, parameterIndex) =>
        bindingNamePaths(parameter.name, returnedMember.symbol, checker).flatMap(formal => {
          if (parameter.dotDotDotToken) {
            const selection = arrayBindingSelection(
              formal.path,
              returnedPath,
              formal.rest?.kind === 'array'
                ? formal.rest
                : { prefixLength: 0, start: 0 },
            );
            if (!selection) return [];
            const [actualOffset, ...sourcePath] = selection.sourcePath;
            const index = actualOffset === undefined ? undefined : canonicalArrayIndex(actualOffset);
            const actual = index === undefined ? undefined : actuals[parameterIndex + index];
            return actual && !ts.isSpreadElement(actual)
              ? pathsAtActual(
                  actual,
                  sourcePath,
                  selection.suffix,
                  checker,
                  seen,
                  resolve,
                )
              : [];
          }
          const supplied = actuals[parameterIndex];
          const actual = !supplied || isStaticallyUndefined(supplied, checker)
            ? parameter.initializer
            : supplied;
          if (formal.rest?.kind === 'array') {
            if (!actual || ts.isSpreadElement(actual)) return [];
            const selection = arrayBindingSelection(
              formal.path,
              returnedPath,
              formal.rest,
            );
            return !selection
              ? []
              : pathsAtActual(
                  actual,
                  selection.sourcePath,
                  selection.suffix,
                  checker,
                  seen,
                  resolve,
                );
          }
          if (formal.rest?.kind === 'object') {
            const [member, ...suffix] = returnedPath;
            return actual && member !== undefined
              && !formal.rest.excluded.includes(String(member))
              && !ts.isSpreadElement(actual)
              ? pathsAtActual(
                  actual,
                  [...formal.path, member],
                  suffix,
                  checker,
                  seen,
                  resolve,
                )
              : [];
          }
          return actual && !ts.isSpreadElement(actual)
            ? pathsAtActual(
                actual,
                formal.path,
                returnedPath,
                checker,
                seen,
                resolve,
              )
            : [];
        }));
      return mapped.length > 0 ? mapped : [{ ...returnedMember, path: returnedPath }];
    })));
}
