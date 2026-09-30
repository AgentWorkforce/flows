import ts from 'typescript';

export type BindingPathSegment = string | number;

export type BindingRest =
  | { excluded: string[]; kind: 'object' }
  | { kind: 'array'; start: number };

export interface AssignedSource {
  initializer: ts.Expression;
  path: BindingPathSegment[];
  rest?: BindingRest;
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
  const segment = checker ? staticPropertySegment(name.expression, checker, seen) : undefined;
  return segment === undefined ? undefined : String(segment);
}

function staticPropertySegment(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): BindingPathSegment | undefined {
  expression = unwrap(expression);
  if (ts.isAwaitExpression(expression)) {
    return staticPropertySegment(expression.expression, checker, new Set(seen));
  }
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  const type = checker.getTypeAtLocation(expression);
  if (type.isStringLiteral()) return type.value;
  if ((type.flags & ts.TypeFlags.NumberLiteral) !== 0) return (type as ts.NumberLiteralType).value;
  const branches = ts.isConditionalExpression(expression)
    ? [expression.whenTrue, expression.whenFalse]
    : ts.isBinaryExpression(expression)
      && (expression.operatorToken.kind === ts.SyntaxKind.CommaToken
        || expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
      ? [expression.left, expression.right]
      : undefined;
  if (branches) {
    const values = branches.map(branch =>
      staticPropertySegment(branch, checker, new Set(seen)));
    const first = values[0];
    return first !== undefined
      && values.every(value => value !== undefined && value === first)
      ? first
      : undefined;
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  const nextSeen = new Set(seen).add(symbol);
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding) {
    const source = bindingSource(binding, checker, new Set(nextSeen));
    if (source?.immutable) {
      const value = staticPropertySegmentAtPath(
        source.initializer,
        source.path,
        checker,
        new Set(nextSeen),
      );
      if (value !== undefined) return value;
    }
    if (binding.initializer) {
      const value = staticPropertySegment(binding.initializer, checker, new Set(nextSeen));
      if (value !== undefined) return value;
    }
  }
  const assigned = assignedSources(symbol, checker)
    .filter(source => source.path.length === 0)
    .map(source => staticPropertySegment(source.initializer, checker, new Set(nextSeen)));
  const firstAssigned = assigned[0];
  if (firstAssigned !== undefined
    && assigned.every(value => value !== undefined && value === firstAssigned)) return firstAssigned;
  const declaration = symbol.declarations?.find(ts.isVariableDeclaration);
  if (!declaration?.initializer || !ts.isVariableDeclarationList(declaration.parent)
    || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
  return staticPropertySegment(declaration.initializer, checker, nextSeen);
}

function staticPropertySegmentAtPath(
  expression: ts.Expression,
  path: readonly BindingPathSegment[],
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): BindingPathSegment | undefined {
  expression = unwrap(expression);
  if (ts.isAwaitExpression(expression)) {
    return staticPropertySegmentAtPath(expression.expression, path, checker, new Set(seen));
  }
  const branches = ts.isConditionalExpression(expression)
    ? [expression.whenTrue, expression.whenFalse]
    : ts.isBinaryExpression(expression)
      && (expression.operatorToken.kind === ts.SyntaxKind.CommaToken
        || expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
      ? [expression.left, expression.right]
      : undefined;
  if (branches) {
    const values = branches.map(branch =>
      staticPropertySegmentAtPath(branch, path, checker, new Set(seen)));
    const first = values[0];
    return first !== undefined
      && values.every(value => value !== undefined && value === first)
      ? first
      : undefined;
  }
  if (path.length === 0) return staticPropertySegment(expression, checker, seen);
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol || seen.has(symbol)) return undefined;
    const nextSeen = new Set(seen).add(symbol);
    const binding = symbol.declarations?.find(ts.isBindingElement);
    if (binding) {
      const source = bindingSource(binding, checker, new Set(nextSeen));
      if (source?.immutable) {
        const value = staticPropertySegmentAtPath(
          source.initializer,
          [...source.path, ...path],
          checker,
          new Set(nextSeen),
        );
        if (value !== undefined) return value;
      }
      if (binding.initializer) {
        const value = staticPropertySegmentAtPath(
          binding.initializer,
          path,
          checker,
          new Set(nextSeen),
        );
        if (value !== undefined) return value;
      }
    }
    const declaration = symbol.declarations?.find(ts.isVariableDeclaration);
    if (!declaration?.initializer || !ts.isVariableDeclarationList(declaration.parent)
      || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
    return staticPropertySegmentAtPath(
      declaration.initializer,
      path,
      checker,
      nextSeen,
    );
  }
  const [head, ...tail] = path;
  if (ts.isObjectLiteralExpression(expression)) {
    for (const property of [...expression.properties].reverse()) {
      if (ts.isSpreadAssignment(property)) {
        const value = staticPropertySegmentAtPath(property.expression, path, checker, new Set(seen));
        if (value !== undefined) return value;
        continue;
      }
      const name = propertyName(property.name, checker, new Set(seen));
      if (name === undefined || String(head) !== name) continue;
      const initializer = ts.isPropertyAssignment(property) ? property.initializer
        : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
      return initializer
        ? staticPropertySegmentAtPath(initializer, tail, checker, new Set(seen))
        : undefined;
    }
    return undefined;
  }
  const index = head === undefined ? undefined : canonicalArrayIndex(head);
  if (!ts.isArrayLiteralExpression(expression) || index === undefined) return undefined;
  const element = expression.elements[index];
  return element && !ts.isOmittedExpression(element) && !ts.isSpreadElement(element)
    ? staticPropertySegmentAtPath(element, tail, checker, new Set(seen))
    : undefined;
}

function canonicalArrayIndex(segment: BindingPathSegment): number | undefined {
  if (typeof segment === 'number') return Number.isInteger(segment) && segment >= 0 ? segment : undefined;
  return /^(?:0|[1-9]\d*)$/u.test(segment) ? Number(segment) : undefined;
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

export function assignmentMayStoreRight(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.EqualsToken
    || kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
    || kind === ts.SyntaxKind.BarBarEqualsToken
    || kind === ts.SyntaxKind.QuestionQuestionEqualsToken;
}
