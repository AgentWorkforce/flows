import ts from 'typescript';
import {
  aggregateValueAtPath,
  staticPropertySegment,
} from './shipped-source-binding-values.js';
import { reflectiveMemberAssignedSources } from './shipped-source-member-writes.js';

export type BindingPathSegment = string | number;

type BindingRest =
  | { excluded: string[]; kind: 'object' }
  | { kind: 'array'; start: number };

export interface AssignedSource {
  initializer: ts.Expression;
  path: BindingPathSegment[];
  rest?: BindingRest;
}

interface MemberAssignedSource {
  initializer: ts.Expression;
  path: BindingPathSegment[];
  rest?: BindingRest;
  sourcePath: BindingPathSegment[];
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
  return expression;
}

function propertyName(
  name: ts.PropertyName | undefined,
  checker?: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (!ts.isComputedPropertyName(name)) return undefined;
  if (ts.isStringLiteralLike(name.expression)) return name.expression.text;
  const segment = checker
    ? staticPropertySegment(name.expression, checker, new Set(seen))
    : undefined;
  return segment === undefined ? undefined : String(segment);
}

function canonicalArrayIndex(segment: BindingPathSegment): number | undefined {
  if (typeof segment === 'number') return Number.isInteger(segment) && segment >= 0 ? segment : undefined;
  return /^(?:0|[1-9]\d*)$/u.test(segment) ? Number(segment) : undefined;
}

function memberAssignmentPath(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): { path: BindingPathSegment[]; symbol: ts.Symbol } | undefined {
  expression = unwrap(expression);
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    return symbol ? { path: [], symbol } : undefined;
  }
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return undefined;
  const parent = memberAssignmentPath(expression.expression, checker);
  if (!parent) return undefined;
  const segment = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : expression.argumentExpression
      ? staticPropertySegment(expression.argumentExpression, checker, new Set([parent.symbol]))
      : undefined;
  return segment === undefined ? undefined : { ...parent, path: [...parent.path, segment] };
}

function memberAssignedSourcesAtTarget(
  target: ts.Expression,
  value: ts.Expression,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  sourcePath: BindingPathSegment[] = [],
): MemberAssignedSource[] {
  target = unwrap(target);
  const member = memberAssignmentPath(target, checker);
  if (member?.symbol === symbol && member.path.length > 0) {
    return [{ initializer: value, path: member.path, sourcePath }];
  }
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return [
      ...memberAssignedSourcesAtTarget(target.left, value, symbol, checker, sourcePath),
      ...memberAssignedSourcesAtTarget(target.left, target.right, symbol, checker),
    ];
  }
  if (ts.isArrayLiteralExpression(target)) return target.elements.flatMap((element, index) => {
    if (ts.isOmittedExpression(element)) return [];
    if (!ts.isSpreadElement(element)) {
      return memberAssignedSourcesAtTarget(element, value, symbol, checker, [...sourcePath, index]);
    }
    return memberAssignedSourcesAtTarget(element.expression, value, symbol, checker, sourcePath)
      .flatMap(source => {
        if (source.initializer !== value) return source;
        const relativePath = source.sourcePath.slice(sourcePath.length);
        if (relativePath.length === 0) return [{
          ...source,
          sourcePath: [...sourcePath],
          rest: {
            kind: 'array' as const,
            start: index + (source.rest?.kind === 'array' ? source.rest.start : 0),
          },
        }];
        const [first, ...tail] = relativePath;
        const relative = canonicalArrayIndex(first!);
        return relative === undefined ? [] : [{
          ...source,
          sourcePath: [...sourcePath, index + relative, ...tail],
        }];
      });
  });
  if (!ts.isObjectLiteralExpression(target)) return [];
  const excluded: string[] = [];
  return target.properties.flatMap(property => {
    if (ts.isSpreadAssignment(property)) {
      return memberAssignedSourcesAtTarget(property.expression, value, symbol, checker, sourcePath)
        .map(source => source.initializer !== value || source.sourcePath.length > sourcePath.length
          ? source
          : {
              ...source,
              sourcePath: [...sourcePath],
              rest: { excluded: [...excluded], kind: 'object' as const },
            });
    }
    const segment = propertyName(property.name, checker);
    if (segment === undefined) return [];
    const assignmentTarget = ts.isPropertyAssignment(property) ? property.initializer
      : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
    if (!assignmentTarget) return [];
    excluded.push(segment);
    return memberAssignedSourcesAtTarget(
      assignmentTarget,
      value,
      symbol,
      checker,
      [...sourcePath, segment],
    );
  });
}

const memberAssignedSourceCache = new WeakMap<
  ts.TypeChecker,
  WeakMap<ts.Symbol, MemberAssignedSource[]>
>();

function memberAssignedSources(symbol: ts.Symbol, checker: ts.TypeChecker): MemberAssignedSource[] {
  let checkerCache = memberAssignedSourceCache.get(checker);
  if (!checkerCache) {
    checkerCache = new WeakMap();
    memberAssignedSourceCache.set(checker, checkerCache);
  }
  const cached = checkerCache.get(symbol);
  if (cached) return cached;
  const source = symbol.valueDeclaration?.getSourceFile() ?? symbol.declarations?.[0]?.getSourceFile();
  if (!source) return [];
  const values: MemberAssignedSource[] = [];
  checkerCache.set(symbol, values);
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && assignmentMayStoreRight(node.operatorToken.kind)) {
      values.push(...memberAssignedSourcesAtTarget(node.left, node.right, symbol, checker));
    }
    if (ts.isCallExpression(node)) values.push(...reflectiveMemberAssignedSources(node, symbol, checker));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return values;
}

export function assignedMemberValues(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): Array<{ value: ts.Expression; auditable: false }> {
  const target = memberAssignmentPath(expression, checker);
  if (!target || target.path.length === 0) return [];
  return memberAssignedSources(target.symbol, checker).flatMap(source => {
    if (source.path.length > target.path.length
      || source.path.some((segment, index) => String(segment) !== String(target.path[index]))) return [];
    const sourceValue = source.sourcePath.length === 0
      ? { value: source.initializer }
      : aggregateValueAtPath(
          source.initializer,
          source.sourcePath,
          checker,
          new Set(seen).add(target.symbol),
        );
    if (!sourceValue) return [];
    let remainder = target.path.slice(source.path.length);
    if (source.rest?.kind === 'object') {
      const name = remainder[0];
      if (name === undefined || source.rest.excluded.includes(String(name))) return [];
    }
    if (source.rest?.kind === 'array') {
      const index = remainder[0] === undefined ? undefined : canonicalArrayIndex(remainder[0]);
      if (index === undefined) return [];
      remainder = [source.rest.start + index, ...remainder.slice(1)];
    }
    if (remainder.length === 0) return [{ value: sourceValue.value, auditable: false as const }];
    const value = aggregateValueAtPath(
      sourceValue.value,
      remainder,
      checker,
      new Set(seen).add(target.symbol),
    );
    return value ? [{ value: value.value, auditable: false as const }] : [];
  });
}

export function bindingSource(
  binding: ts.BindingElement,
  checker?: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): {
  defaults: Array<{ applyRest: boolean; expression: ts.Expression; path: BindingPathSegment[] }>;
  initializer: ts.Expression;
  immutable: boolean;
  path: BindingPathSegment[];
  rest?: BindingRest;
} | undefined {
  const defaults: Array<{ applyRest: boolean; expression: ts.Expression; path: BindingPathSegment[] }> = [];
  const path: BindingPathSegment[] = [];
  let rest: BindingRest | undefined;
  let current = binding;
  while (ts.isObjectBindingPattern(current.parent) || ts.isArrayBindingPattern(current.parent)) {
    let defaultPath: BindingPathSegment[] | undefined;
    if (current.dotDotDotToken) {
      if (ts.isArrayBindingPattern(current.parent) && current !== binding) {
        const start = current.parent.elements.indexOf(current);
        const index = path[0] === undefined ? undefined : canonicalArrayIndex(path[0]);
        if (start < 0 || index === undefined) return undefined;
        defaultPath = path.slice();
        path[0] = index + start;
      } else if (rest) {
        return undefined;
      } else if (ts.isObjectBindingPattern(current.parent)) {
        rest = {
          excluded: current.parent.elements
            .filter(element => element !== current && !element.dotDotDotToken)
            .map(element => propertyName(
              element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined),
              checker,
              seen,
            ))
            .filter((name): name is string => name !== undefined),
          kind: 'object',
        };
      } else {
        const start = current.parent.elements.indexOf(current);
        if (start < 0) return undefined;
        rest = { kind: 'array', start };
      }
    } else {
      const segment = ts.isObjectBindingPattern(current.parent)
        ? propertyName(
            current.propertyName ?? (ts.isIdentifier(current.name) ? current.name : undefined),
            checker,
            seen,
          )
        : current.parent.elements.indexOf(current);
      if (segment === undefined || (typeof segment === 'number' && segment < 0)) return undefined;
      path.unshift(segment);
    }
    if (current.initializer) defaults.push({
      applyRest: rest?.kind === 'array' && !current.dotDotDotToken,
      expression: current.initializer,
      path: defaultPath ?? path.slice(1),
    });
    const owner = current.parent.parent;
    if (ts.isBindingElement(owner)) {
      current = owner;
      continue;
    }
    if (!ts.isVariableDeclaration(owner) || !owner.initializer
      || !ts.isVariableDeclarationList(owner.parent)) return undefined;
    return {
      defaults,
      initializer: owner.initializer,
      immutable: (owner.parent.flags & ts.NodeFlags.Const) !== 0,
      path,
      rest,
    };
  }
  return undefined;
}

export function bindingDefaultValues(
  source: ReturnType<typeof bindingSource> & {},
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): Array<{ value: ts.Expression; auditable: boolean; applyRest: boolean; symbol?: ts.Symbol }> {
  return source.defaults.flatMap(fallback => {
    if (fallback.path.length === 0) return [{
      value: fallback.expression,
      auditable: false,
      applyRest: fallback.applyRest,
    }];
    const value = aggregateValueAtPath(fallback.expression, fallback.path, checker, new Set(seen));
    return value ? [{ ...value, auditable: false, applyRest: fallback.applyRest }] : [];
  });
}

const assignedSourceCache = new WeakMap<ts.TypeChecker, WeakMap<ts.Symbol, AssignedSource[]>>();

function assignedSourcesAtTarget(
  target: ts.Expression,
  value: ts.Expression,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  path: BindingPathSegment[] = [],
): AssignedSource[] {
  target = unwrap(target);
  if (ts.isIdentifier(target)) {
    const targetSymbol = ts.isShorthandPropertyAssignment(target.parent)
      ? checker.getShorthandAssignmentValueSymbol(target.parent)
      : checker.getSymbolAtLocation(target);
    return targetSymbol === symbol ? [{ initializer: value, path }] : [];
  }
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return [
      ...assignedSourcesAtTarget(target.left, value, symbol, checker, path),
      ...assignedSourcesAtTarget(target.left, target.right, symbol, checker),
    ];
  }
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.flatMap((element, index) => {
      if (ts.isOmittedExpression(element)) return [];
      if (!ts.isSpreadElement(element)) {
        return assignedSourcesAtTarget(element, value, symbol, checker, [...path, index]);
      }
      return assignedSourcesAtTarget(element.expression, value, symbol, checker).flatMap(source => {
        if (source.initializer !== value) return source;
        if (source.path.length === 0) return [{
          ...source,
          path: [...path],
          rest: {
            kind: 'array' as const,
            start: index + (source.rest?.kind === 'array' ? source.rest.start : 0),
          },
        }];
        const [first, ...tail] = source.path;
        const relative = canonicalArrayIndex(first!);
        return relative === undefined ? [] : [{
          ...source,
          path: [...path, index + relative, ...tail],
        }];
      });
    });
  }
  if (!ts.isObjectLiteralExpression(target)) return [];
  const excluded: string[] = [];
  return target.properties.flatMap(property => {
    if (ts.isSpreadAssignment(property)) {
      return assignedSourcesAtTarget(property.expression, value, symbol, checker).map(source =>
        source.initializer !== value || source.path.length > 0 ? source : {
          ...source,
          path: [...path],
          rest: { excluded: [...excluded], kind: 'object' as const },
        });
    }
    const segment = propertyName(property.name, checker);
    if (segment === undefined) return [];
    excluded.push(segment);
    return ts.isShorthandPropertyAssignment(property)
      ? [
          ...assignedSourcesAtTarget(property.name, value, symbol, checker, [...path, segment]),
          ...(property.objectAssignmentInitializer
            ? assignedSourcesAtTarget(property.name, property.objectAssignmentInitializer, symbol, checker)
            : []),
        ]
      : ts.isPropertyAssignment(property)
        ? assignedSourcesAtTarget(property.initializer, value, symbol, checker, [...path, segment])
        : [];
  });
}

export function assignedSources(symbol: ts.Symbol, checker: ts.TypeChecker): AssignedSource[] {
  let checkerCache = assignedSourceCache.get(checker);
  if (!checkerCache) {
    checkerCache = new WeakMap();
    assignedSourceCache.set(checker, checkerCache);
  }
  const cached = checkerCache.get(symbol);
  if (cached) return cached;
  const source = symbol.valueDeclaration?.getSourceFile() ?? symbol.declarations?.[0]?.getSourceFile();
  if (!source) return [];
  const values: AssignedSource[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && assignmentMayStoreRight(node.operatorToken.kind)) {
      values.push(...assignedSourcesAtTarget(node.left, node.right, symbol, checker));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  checkerCache.set(symbol, values);
  return values;
}

export function assignedValues(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Expression[] {
  return assignedSources(symbol, checker).flatMap(source => {
    if (source.rest) return [];
    if (source.path.length === 0) return [source.initializer];
    const value = aggregateValueAtPath(source.initializer, source.path, checker, new Set());
    return value ? [value.value] : [];
  });
}

export function assignmentMayStoreRight(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.EqualsToken
    || kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
    || kind === ts.SyntaxKind.BarBarEqualsToken
    || kind === ts.SyntaxKind.QuestionQuestionEqualsToken;
}
