import ts from 'typescript';
import type { BindingPathSegment } from './shipped-source-binding-provenance.js';
import { aggregateValueAtPath } from './shipped-source-binding-values.js';
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
  const relativeOffset = formalOffset ?? returnedOffset ?? 0;
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

export function localCallTargetPaths(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
  resolve: ResolveTargetPaths,
): LocalCallTargetPath[] {
  const declaration = checker.getResolvedSignature(expression)?.declaration;
  if (!declaration || !ts.isFunctionLike(declaration) || !('body' in declaration)) return [];
  const actualCandidates = localCallArgumentCandidates(expression.arguments, checker);
  return actualCandidates.flatMap(actuals => returnedExpressions(declaration.body).flatMap(returned =>
    resolve(returned, new Set(seen)).flatMap(returnedMember => {
      const mapped = declaration.parameters.flatMap((parameter, parameterIndex) =>
        bindingNamePaths(parameter.name, returnedMember.symbol, checker).flatMap(formal => {
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
              returnedMember.path,
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
            const [member, ...suffix] = returnedMember.path;
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
                returnedMember.path,
                checker,
                seen,
                resolve,
              )
            : [];
        }));
      return mapped.length > 0 ? mapped : [returnedMember];
    })));
}
