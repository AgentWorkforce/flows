import ts from 'typescript';

export type BindingPathSegment = string | number;

export type BindingRest =
  | { excluded: string[]; kind: 'object' }
  | { kind: 'array'; start: number };

export interface AssignedSource {
  initializer: ts.Expression;
  iterationValue?: boolean;
  path: BindingPathSegment[];
  rest?: BindingRest;
}

interface BindingTargetResolvers {
  assignedSourcesAtTarget(
    target: ts.Expression,
    value: ts.Expression,
    symbol: ts.Symbol,
    checker: ts.TypeChecker,
    path?: BindingPathSegment[],
  ): AssignedSource[];
  propertyName(name: ts.PropertyName | undefined, checker: ts.TypeChecker): string | undefined;
}

function canonicalArrayIndex(segment: BindingPathSegment): number | undefined {
  if (typeof segment === 'number') {
    return Number.isInteger(segment) && segment >= 0 ? segment : undefined;
  }
  return /^(?:0|[1-9]\d*)$/u.test(segment) ? Number(segment) : undefined;
}

function prefixArrayRest(
  source: AssignedSource,
  value: ts.Expression,
  path: BindingPathSegment[],
  start: number,
): AssignedSource[] {
  if (source.initializer !== value) return [source];
  if (source.path.length === 0) return [{
    ...source,
    path: [...path],
    rest: {
      kind: 'array',
      start: start + (source.rest?.kind === 'array' ? source.rest.start : 0),
    },
  }];
  const [first, ...tail] = source.path;
  const relative = canonicalArrayIndex(first!);
  return relative === undefined ? [] : [{
    ...source,
    path: [...path, start + relative, ...tail],
  }];
}

export function assignedSourcesAtBindingName(
  target: ts.BindingName,
  value: ts.Expression,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  resolvers: BindingTargetResolvers,
  path: BindingPathSegment[] = [],
): AssignedSource[] {
  if (ts.isIdentifier(target)) {
    return resolvers.assignedSourcesAtTarget(target, value, symbol, checker, path);
  }
  const recurse = (name: ts.BindingName, expression: ts.Expression, nextPath: BindingPathSegment[] = []) =>
    assignedSourcesAtBindingName(name, expression, symbol, checker, resolvers, nextPath);
  if (ts.isArrayBindingPattern(target)) {
    return target.elements.flatMap((element, index) => {
      if (ts.isOmittedExpression(element)) return [];
      const defaults = element.initializer ? recurse(element.name, element.initializer) : [];
      if (!element.dotDotDotToken) return [
        ...recurse(element.name, value, [...path, index]),
        ...defaults,
      ];
      return [
        ...recurse(element.name, value)
          .flatMap(source => prefixArrayRest(source, value, path, index)),
        ...defaults,
      ];
    });
  }
  const excluded = target.elements
    .filter(element => !element.dotDotDotToken)
    .map(element => resolvers.propertyName(
      element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined),
      checker,
    ))
    .filter((name): name is string => name !== undefined);
  return target.elements.flatMap(element => {
    const defaults = element.initializer ? recurse(element.name, element.initializer) : [];
    if (element.dotDotDotToken) return [
      ...recurse(element.name, value).map(source =>
        source.initializer !== value || source.path.length > 0 ? source : {
          ...source,
          path: [...path],
          rest: { excluded, kind: 'object' as const },
        }),
      ...defaults,
    ];
    const segment = resolvers.propertyName(
      element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined),
      checker,
    );
    return segment === undefined ? defaults : [
      ...recurse(element.name, value, [...path, segment]),
      ...defaults,
    ];
  });
}
