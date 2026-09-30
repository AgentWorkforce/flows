import ts from 'typescript';
import type { BindingPathSegment } from './shipped-source-binding-provenance.js';
import { aggregateValueAtPath, staticPropertySegment } from './shipped-source-binding-values.js';
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
  candidates: ts.Expression[];
  seen: Set<ts.Symbol>;
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
  const value = sourcePath.length === 0
    ? { value: actual }
    : aggregateValueAtPath(actual, sourcePath, checker, new Set(seen));
  return value
    ? resolve(value.value, new Set(seen))
      .map(parent => ({ ...parent, path: [...parent.path, ...suffix] }))
    : [];
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

function valueAtActual(
  actual: ts.Expression,
  sourcePath: readonly BindingPathSegment[],
  suffix: readonly BindingPathSegment[],
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): ts.Expression | undefined {
  const selected = sourcePath.length === 0
    ? { value: actual }
    : aggregateValueAtPath(actual, sourcePath, checker, new Set(seen));
  if (!selected) return undefined;
  return suffix.length === 0
    ? selected.value
    : aggregateValueAtPath(selected.value, suffix, checker, new Set(seen))?.value;
}

/** Resolve local return expressions to their call actuals for value analysis. */
export function localCallValueCandidates(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): LocalCallValueResolution | undefined {
  const declaration = checker.getResolvedSignature(expression)?.declaration;
  const callee = checker.getSymbolAtLocation(unwrap(expression.expression));
  if (!declaration || !ts.isFunctionLike(declaration) || !('body' in declaration)
    || (callee && seen.has(callee))) return undefined;
  const nextSeen = callee ? new Set(seen).add(callee) : new Set(seen);
  const actualCandidates = localCallArgumentCandidates(expression.arguments, checker);
  const candidates = returnedExpressions(declaration.body).flatMap(returned => {
    const returnedMember = expressionRootPath(returned, checker, nextSeen);
    if (!returnedMember) return [returned];
    const mapped = declaration.parameters.flatMap((parameter, parameterIndex) =>
      bindingNamePaths(parameter.name, returnedMember.symbol, checker).flatMap(formal =>
        actualCandidates.flatMap(actuals => {
          if (parameter.dotDotDotToken) {
            const selection = arrayBindingSelection(
              formal.path,
              returnedMember.path,
              formal.rest?.kind === 'array'
                ? formal.rest
                : { prefixLength: 0, start: 0 },
            );
            if (!selection) return [];
            const [actualOffset, ...sourcePath] = selection.sourcePath;
            const index = actualOffset === undefined ? undefined : canonicalArrayIndex(actualOffset);
            const actual = index === undefined ? undefined : actuals[parameterIndex + index];
            const value = actual && !ts.isSpreadElement(actual)
              ? valueAtActual(actual, sourcePath, selection.suffix, checker, nextSeen)
              : undefined;
            return value ? [value] : [];
          }
          const supplied = actuals[parameterIndex];
          const actual = !supplied || isStaticallyUndefined(supplied, checker)
            ? parameter.initializer
            : supplied;
          if (!actual || ts.isSpreadElement(actual)) return [];
          if (formal.rest?.kind === 'array') {
            const selection = arrayBindingSelection(formal.path, returnedMember.path, formal.rest);
            const value = selection
              ? valueAtActual(actual, selection.sourcePath, selection.suffix, checker, nextSeen)
              : undefined;
            return value ? [value] : [];
          }
          if (formal.rest?.kind === 'object') {
            const [member, ...suffix] = returnedMember.path;
            if (member === undefined || formal.rest.excluded.includes(String(member))) return [];
            const value = valueAtActual(actual, [...formal.path, member], suffix, checker, nextSeen);
            return value ? [value] : [];
          }
          const value = valueAtActual(
            actual,
            formal.path,
            returnedMember.path,
            checker,
            nextSeen,
          );
          return value ? [value] : [];
        })));
    return mapped.length > 0 ? mapped : [returned];
  });
  return { candidates, seen: nextSeen };
}

export function localCallTargetPaths(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
  resolve: ResolveTargetPaths,
  callerPath: readonly BindingPathSegment[] = [],
): LocalCallTargetPath[] {
  const declaration = checker.getResolvedSignature(expression)?.declaration;
  if (!declaration || !ts.isFunctionLike(declaration) || !('body' in declaration)) return [];
  const actualCandidates = localCallArgumentCandidates(expression.arguments, checker);
  return actualCandidates.flatMap(actuals => returnedExpressions(declaration.body).flatMap(returned =>
    resolve(returned, new Set(seen)).flatMap(returnedMember => {
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
