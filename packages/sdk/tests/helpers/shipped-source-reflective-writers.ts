import ts from 'typescript';
import {
  bindingDefaultValues,
  bindingSource,
} from './shipped-source-binding-provenance.js';
import {
  aggregateExpressionValues,
  aggregateValueAtPath,
  staticMemberSegment,
  wrappedExpressionBranches,
} from './shipped-source-binding-values.js';

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
  return expression;
}

function memberName(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): string | undefined {
  const segment = staticMemberSegment(expression, checker, seen);
  return typeof segment === 'string' ? segment : undefined;
}

function memberReceiver(expression: ts.Expression): ts.Expression | undefined {
  expression = unwrap(expression);
  return ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
    ? expression.expression
    : undefined;
}

const REFLECTIVE_WRITERS = {
  Object: new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf']),
  Reflect: new Set(['set', 'defineProperty', 'deleteProperty', 'setPrototypeOf']),
} as const;

function referencesIntrinsic(
  expression: ts.Expression,
  intrinsic: keyof typeof REFLECTIVE_WRITERS,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean {
  expression = unwrap(expression);
  if (ts.isIdentifier(expression)) {
    if (expression.text === intrinsic) return true;
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    const binding = symbol.declarations?.find(ts.isBindingElement);
    if (binding?.initializer
      && referencesIntrinsic(binding.initializer, intrinsic, checker, new Set(seen))) return true;
    if (binding) {
      const source = bindingSource(binding, checker);
      if (source) {
        const values = [
          aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen)),
          ...bindingDefaultValues(source, checker, new Set(seen)),
        ].filter((value): value is NonNullable<typeof value> => value !== undefined);
        if (values.some(value => referencesIntrinsic(
          value.value,
          intrinsic,
          checker,
          new Set(seen),
        ))) return true;
      }
    }
    const declaration = symbol.declarations?.find(ts.isVariableDeclaration);
    return declaration?.initializer !== undefined
      && referencesIntrinsic(declaration.initializer, intrinsic, checker, seen);
  }
  const memberSeen = new Set(seen);
  for (const member of aggregateExpressionValues(expression, checker, memberSeen)) {
    if (referencesIntrinsic(member.value, intrinsic, checker, new Set(memberSeen))) return true;
  }
  const branches = wrappedExpressionBranches(expression);
  return branches?.some(branch => referencesIntrinsic(branch, intrinsic, checker, new Set(seen))) ?? false;
}

function reflectiveWriter(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): { intrinsic: keyof typeof REFLECTIVE_WRITERS; name: string } | undefined {
  const name = memberName(expression, checker, new Set(seen));
  const receiver = memberReceiver(expression);
  if (!name || !receiver) return undefined;
  const entry = (Object.entries(REFLECTIVE_WRITERS) as Array<[
    keyof typeof REFLECTIVE_WRITERS,
    ReadonlySet<string>,
  ]>).find(([intrinsic, names]) => names.has(name)
    && referencesIntrinsic(receiver, intrinsic, checker, new Set(seen)));
  return entry ? { intrinsic: entry[0], name } : undefined;
}

export function directReflectiveWriterTargets(
  node: ts.Node,
  checker: ts.TypeChecker,
): readonly number[] | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const writer = reflectiveWriter(node.expression, checker, new Set());
  if (!writer) return undefined;
  return writer.intrinsic === 'Reflect' && writer.name === 'set' ? [0, 3] : [0];
}

export function referencesReflectiveWriter(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean {
  expression = unwrap(expression);
  if (reflectiveWriter(expression, checker, seen)) return true;
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    const binding = symbol.declarations?.find(ts.isBindingElement);
    if (binding?.initializer
      && referencesReflectiveWriter(binding.initializer, checker, new Set(seen))) return true;
    if (binding) {
      const source = bindingSource(binding, checker);
      if (source) {
        const values = [
          aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen)),
          ...bindingDefaultValues(source, checker, new Set(seen)),
        ].filter((value): value is NonNullable<typeof value> => value !== undefined);
        if (values.some(value => referencesReflectiveWriter(value.value, checker, new Set(seen)))) return true;
        const name = source.path.at(-1);
        if (typeof name === 'string') {
          const receiverPath = source.path.slice(0, -1);
          const receiver = receiverPath.length === 0
            ? source.initializer
            : aggregateValueAtPath(source.initializer, receiverPath, checker, new Set(seen))?.value;
          if (receiver && (Object.entries(REFLECTIVE_WRITERS) as Array<[
            keyof typeof REFLECTIVE_WRITERS,
            ReadonlySet<string>,
          ]>).some(([intrinsic, names]) => names.has(name)
            && referencesIntrinsic(receiver, intrinsic, checker, new Set(seen)))) return true;
        }
      }
    }
    const declaration = symbol.declarations?.find(ts.isVariableDeclaration);
    return declaration?.initializer !== undefined
      && referencesReflectiveWriter(declaration.initializer, checker, seen);
  }
  const memberSeen = new Set(seen);
  for (const member of aggregateExpressionValues(expression, checker, memberSeen)) {
    if (referencesReflectiveWriter(member.value, checker, new Set(memberSeen))) return true;
  }
  const branches = wrappedExpressionBranches(expression);
  if (branches) return branches.some(branch => referencesReflectiveWriter(branch, checker, new Set(seen)));
  const receiver = memberReceiver(expression);
  if (receiver && ['call', 'apply', 'bind'].includes(
    memberName(expression, checker, new Set(seen)) ?? '',
  )) {
    return referencesReflectiveWriter(receiver, checker, seen);
  }
  return ts.isCallExpression(expression)
    ? referencesReflectiveWriter(expression.expression, checker, seen)
    : false;
}
