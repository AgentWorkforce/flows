import ts from 'typescript';
import {
  assignedSources,
  bindingSource,
} from './shipped-source-binding-provenance.js';
import { baseAggregateExpressionValues } from './shipped-source-base-aggregate-values.js';
import {
  aggregateValueAtPath,
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

function referencesGlobalIdentifier(
  expression: ts.Expression,
  globalName: string,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): boolean {
  expression = unwrap(expression);
  if (ts.isIdentifier(expression) && expression.text === globalName) return true;
  const globalReceiver = memberReceiver(expression);
  if (staticMemberSegment(expression, checker, new Set(seen)) === globalName
    && globalReceiver
    && referencesGlobalIdentifier(globalReceiver, 'globalThis', checker, new Set(seen))) return true;
  const branches = wrappedExpressionBranches(expression);
  if (branches) return branches.some(branch =>
    referencesGlobalIdentifier(branch, globalName, checker, new Set(seen)));
  const aggregateSeen = new Set(seen);
  for (const aggregate of baseAggregateExpressionValues(expression, checker, aggregateSeen)) {
    if (referencesGlobalIdentifier(
      aggregate.value,
      globalName,
      checker,
      new Set(aggregateSeen),
    )) return true;
  }
  if (!ts.isIdentifier(expression)) return false;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding?.initializer && referencesGlobalIdentifier(
    binding.initializer,
    globalName,
    checker,
    new Set(seen),
  )) return true;
  if (binding) {
    const source = bindingSource(binding, checker);
    const values = source ? [
      aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen)),
      ...bindingDefaultValues(source, checker, new Set(seen)),
    ].filter((value): value is NonNullable<typeof value> => value !== undefined) : [];
    if (values.some(value => referencesGlobalIdentifier(
      value.value,
      globalName,
      checker,
      new Set(seen),
    ))) return true;
  }
  if (assignedValues(symbol, checker).some(value =>
    referencesGlobalIdentifier(value, globalName, checker, new Set(seen)))) return true;
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  return !!variable?.initializer
    && referencesGlobalIdentifier(variable.initializer, globalName, checker, seen);
}

export function referencesGlobalMember(
  expression: ts.Expression,
  globalName: string,
  name: string,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean {
  expression = unwrap(expression);
  const receiver = memberReceiver(expression);
  if (staticMemberSegment(expression, checker, new Set(seen)) === name && receiver
    && referencesGlobalIdentifier(receiver, globalName, checker, new Set(seen))) return true;
  const branches = wrappedExpressionBranches(expression);
  if (branches) return branches.some(branch =>
    referencesGlobalMember(branch, globalName, name, checker, new Set(seen)));
  const aggregateSeen = new Set(seen);
  for (const aggregate of baseAggregateExpressionValues(expression, checker, aggregateSeen)) {
    if (referencesGlobalMember(
      aggregate.value,
      globalName,
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
  if (binding?.initializer && referencesGlobalMember(
    binding.initializer,
    globalName,
    name,
    checker,
    new Set(seen),
  )) return true;
  if (binding) {
    const source = bindingSource(binding, checker);
    if (source?.path.at(-1) === name) {
      const receiverPath = source.path.slice(0, -1);
      const sourceReceiver = receiverPath.length === 0
        ? source.initializer
        : aggregateValueAtPath(source.initializer, receiverPath, checker, new Set(seen))?.value;
      if (sourceReceiver && referencesGlobalIdentifier(
        sourceReceiver,
        globalName,
        checker,
        new Set(seen),
      )) return true;
    }
    const values = source ? [
      aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen)),
      ...bindingDefaultValues(source, checker, new Set(seen)),
    ].filter((value): value is NonNullable<typeof value> => value !== undefined) : [];
    if (values.some(value => referencesGlobalMember(
      value.value,
      globalName,
      name,
      checker,
      new Set(seen),
    ))) return true;
  }
  for (const source of assignedSources(symbol, checker)) {
    if (source.rest || source.path.at(-1) !== name) continue;
    const receiverPath = source.path.slice(0, -1);
    const sourceReceiver = receiverPath.length === 0
      ? source.initializer
      : aggregateValueAtPath(source.initializer, receiverPath, checker, new Set(seen))?.value;
    if (sourceReceiver && referencesGlobalIdentifier(
      sourceReceiver,
      globalName,
      checker,
      new Set(seen),
    )) return true;
  }
  if (assignedValues(symbol, checker).some(value =>
    referencesGlobalMember(value, globalName, name, checker, new Set(seen)))) return true;
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  return !!variable?.initializer
    && referencesGlobalMember(variable.initializer, globalName, name, checker, seen);
}
