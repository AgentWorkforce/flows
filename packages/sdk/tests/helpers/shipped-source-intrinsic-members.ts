import ts from 'typescript';
import {
  assignedSources,
  bindingSource,
} from './shipped-source-binding-provenance.js';
import { baseAggregateExpressionValues } from './shipped-source-base-aggregate-values.js';
import {
  aggregateValuesAtPath,
  assignedValues,
  bindingDefaultValues,
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

function memberReceiver(expression: ts.Expression): ts.Expression | undefined {
  expression = unwrap(expression);
  return ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
    ? expression.expression
    : undefined;
}

function referencesIntrinsicIdentifier(
  expression: ts.Expression,
  intrinsic: 'Object' | 'Reflect' | 'globalThis',
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean {
  expression = unwrap(expression);
  if (ts.isIdentifier(expression) && expression.text === intrinsic) return true;
  const receiver = memberReceiver(expression);
  if (intrinsic !== 'globalThis'
    && staticMemberSegment(expression, checker, new Set(seen)) === intrinsic
    && receiver
    && referencesIntrinsicIdentifier(receiver, 'globalThis', checker, new Set(seen))) return true;
  const branches = wrappedExpressionBranches(expression);
  if (branches) return branches.some(branch =>
    referencesIntrinsicIdentifier(branch, intrinsic, checker, new Set(seen)));
  if (!ts.isIdentifier(expression)) return false;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding?.initializer && referencesIntrinsicIdentifier(
    binding.initializer,
    intrinsic,
    checker,
    new Set(seen),
  )) return true;
  if (binding) {
    const source = bindingSource(binding, checker, new Set(seen));
    if (source) {
      const values = [
        ...aggregateValuesAtPath(source.initializer, source.path, checker, new Set(seen))
          .map(value => ({ value })),
        ...bindingDefaultValues(source, checker, new Set(seen)),
      ];
      if (values.some(value => referencesIntrinsicIdentifier(
        value.value,
        intrinsic,
        checker,
        new Set(seen),
      ))) return true;
      if (source.path.at(-1) === intrinsic) {
        const receiverPath = source.path.slice(0, -1);
        const sourceReceivers = receiverPath.length === 0
          ? [source.initializer]
          : aggregateValuesAtPath(source.initializer, receiverPath, checker, new Set(seen));
        if (sourceReceivers.some(sourceReceiver => referencesIntrinsicIdentifier(
          sourceReceiver,
          'globalThis',
          checker,
          new Set(seen),
        ))) return true;
      }
    }
  }
  if (assignedValues(symbol, checker).some(value => referencesIntrinsicIdentifier(
    value,
    intrinsic,
    checker,
    new Set(seen),
  ))) return true;
  const declaration = symbol.declarations?.find(ts.isVariableDeclaration);
  return declaration?.initializer !== undefined
    && referencesIntrinsicIdentifier(declaration.initializer, intrinsic, checker, seen);
}

export function referencesIntrinsicMember(
  expression: ts.Expression,
  intrinsic: 'Object' | 'Reflect',
  name: string,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean {
  expression = unwrap(expression);
  const receiver = memberReceiver(expression);
  if (staticMemberSegment(expression, checker, new Set(seen)) === name && receiver
    && referencesIntrinsicIdentifier(receiver, intrinsic, checker, new Set(seen))) return true;
  const branches = wrappedExpressionBranches(expression);
  if (branches) return branches.some(branch =>
    referencesIntrinsicMember(branch, intrinsic, name, checker, new Set(seen)));
  const aggregateSeen = new Set(seen);
  for (const aggregate of baseAggregateExpressionValues(expression, checker, aggregateSeen)) {
    if (referencesIntrinsicMember(
      aggregate.value,
      intrinsic,
      name,
      checker,
      new Set(aggregateSeen),
    )) return true;
  }
  if (!ts.isIdentifier(expression)) return false;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding?.initializer && referencesIntrinsicMember(
    binding.initializer,
    intrinsic,
    name,
    checker,
    new Set(seen),
  )) return true;
  if (binding) {
    const source = bindingSource(binding, checker, new Set(seen));
    if (source?.path.at(-1) === name) {
      const receiverPath = source.path.slice(0, -1);
      const sourceReceivers = receiverPath.length === 0
        ? [source.initializer]
        : aggregateValuesAtPath(source.initializer, receiverPath, checker, new Set(seen));
      if (sourceReceivers.some(sourceReceiver => referencesIntrinsicIdentifier(
        sourceReceiver,
        intrinsic,
        checker,
        new Set(seen),
      ))) return true;
    }
    const values = source ? [
      ...aggregateValuesAtPath(source.initializer, source.path, checker, new Set(seen))
        .map(value => ({ value })),
      ...bindingDefaultValues(source, checker, new Set(seen)),
    ] : [];
    if (values.some(value => referencesIntrinsicMember(
      value.value,
      intrinsic,
      name,
      checker,
      new Set(seen),
    ))) return true;
  }
  for (const source of assignedSources(symbol, checker)) {
    if (source.rest || source.path.at(-1) !== name) continue;
    const receiverPath = source.path.slice(0, -1);
    const sourceReceivers = receiverPath.length === 0
      ? [source.initializer]
      : aggregateValuesAtPath(source.initializer, receiverPath, checker, new Set(seen));
    if (sourceReceivers.some(sourceReceiver => referencesIntrinsicIdentifier(
      sourceReceiver,
      intrinsic,
      checker,
      new Set(seen),
    ))) return true;
  }
  if (assignedValues(symbol, checker).some(value => referencesIntrinsicMember(
    value,
    intrinsic,
    name,
    checker,
    new Set(seen),
  ))) return true;
  const declaration = symbol.declarations?.find(ts.isVariableDeclaration);
  return declaration?.initializer !== undefined
    && referencesIntrinsicMember(declaration.initializer, intrinsic, name, checker, seen);
}
