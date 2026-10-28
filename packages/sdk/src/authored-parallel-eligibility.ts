import ts from 'typescript';
import { authoredFunctionSource } from './authored-flow-lifecycle.js';

const reservedCertifier = '__certifyParallelBranch';

/** Keep admission and call-site instrumentation in agreement on parentheses. */
export function unwrapParallelExpression(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? unwrapParallelExpression(node.expression) : node;
}

/** A closed grammar for deterministic Promise.all branches. Unknown bodies stay serial. */
export function parallelRunEligible(body: Function, moduleSource: string): boolean {
  // Promise.all is intercepted only when `Promise` resolves to the intrinsic.
  // Function.toString cannot see a module-level lexical binding, so inspect
  // the complete source before using the body's narrower grammar.
  const bodySource = authoredFunctionSource(body);
  return certifiedModuleBody(moduleSource, bodySource) !== undefined && parallelBodySyntaxEligible(body);
}

/**
 * Match the body Node actually loaded against the same type-stripped source its
 * TypeScript loader serves. First certify the original bytes: transforming
 * away a declaration must never make an unsafe module appear closed.
 */
export async function parallelLoadedBodyEligible(
  body: Function, moduleSource: string, sourceUrl: string,
  mode: 'strip' | 'transform',
): Promise<boolean> {
  if (!parallelPinnedSourceEligible(moduleSource)) return false;
  const { stripTypeScriptTypes } = await import('node:module') as unknown as {
    stripTypeScriptTypes?: (source: string, options: { mode: 'strip' | 'transform'; sourceUrl: string }) => string;
  };
  if (typeof stripTypeScriptTypes !== 'function') return false;
  // The pinned loader suppresses this one Node warning on its own thread.
  // Recomputing the text here happens on the main thread; suppress only this
  // call's warning and restore the original writer before yielding again.
  const emitWarning = process.emitWarning;
  let transformed: string;
  try {
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      if (rest[0] === 'ExperimentalWarning' && String(warning).startsWith('stripTypeScriptTypes')) return;
      (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    transformed = stripTypeScriptTypes(moduleSource, { mode, sourceUrl });
  } catch {
    // A loader mode unavailable in this Node version cannot certify a body.
    return false;
  } finally {
    process.emitWarning = emitWarning;
  }
  return parallelRunEligible(body, transformed);
}

/**
 * The compiled Bun CLI owns the root lease, but the pinned source is executed
 * by its embedded Node child. Bun reformats function toString output, so its
 * in-memory body cannot be compared byte-for-byte with the source. Certify
 * the closed source module instead; the Node child loads those hash-pinned
 * bytes and checks exact body/source identity and grammar before any child starts.
 */
export function parallelPinnedSourceEligible(moduleSource: string): boolean {
  const bodySource = certifiedModuleBody(moduleSource);
  return bodySource !== undefined && parallelBodySourceSyntaxEligible(bodySource);
}

/** Independently re-check the closed body grammar at execution time. */
export function parallelBodySyntaxEligible(body: Function): boolean {
  return parallelBodySourceSyntaxEligible(authoredFunctionSource(body));
}

function parallelBodySourceSyntaxEligible(bodySource: string): boolean {
  const file = ts.createSourceFile('authored-body.js', `const body = ${bodySource};`,
    ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  if (file.statements.length !== 1) return false;
  const declaration = file.statements[0];
  if (!declaration || !ts.isVariableStatement(declaration)) return false;
  const expression = declaration.declarationList.declarations[0]?.initializer;
  // Function expressions can obtain the context through `arguments[0]`.
  if (expression === undefined || !ts.isArrowFunction(expression) || !ts.isBlock(expression.body)
    || expression.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) !== true) return false;
  const parameter = expression.parameters[0]?.name;
  if (parameter === undefined || !ts.isIdentifier(parameter) || expression.parameters.length !== 1) return false;
  const context = parameter.text;
  if (['Promise', 'globalThis', 'global'].includes(context)) return false;
  // The instrumented body is re-evaluated with a private callback parameter.
  // A lexical binding or reference with that spelling could capture it.
  let namesCertifier = false;
  const checkCertifierName = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === reservedCertifier) namesCertifier = true;
    ts.forEachChild(node, checkCertifierName);
  };
  checkCertifierName(expression);
  if (namesCertifier) return false;
  const branches = new Map<string, ts.ArrowFunction>();
  const rootValues = new Set<string>();
  let groups = 0;
  let runs = 0;

  const unwrap = unwrapParallelExpression;
  const method = (node: ts.Expression, owner: string, name: string): node is ts.CallExpression => {
    const value = unwrap(node);
    return ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)
      && ts.isIdentifier(value.expression.expression) && value.expression.expression.text === owner
      && value.expression.name.text === name;
  };
  const pure = (node: ts.Expression, values: ReadonlySet<string>): boolean => {
    const value = unwrap(node);
    if (ts.isStringLiteral(value) || ts.isNumericLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)
      || value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword
      || value.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isIdentifier(value)) return values.has(value.text);
    if (ts.isTemplateExpression(value)) return value.templateSpans.every(span => pure(span.expression, values));
    if (ts.isPrefixUnaryExpression(value)) return [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken,
      ts.SyntaxKind.ExclamationToken].includes(value.operator) && pure(value.operand, values);
    if (ts.isBinaryExpression(value)) return [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken,
      ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.LessThanToken,
      ts.SyntaxKind.GreaterThanToken].includes(value.operatorToken.kind)
      && pure(value.left, values) && pure(value.right, values);
    if (ts.isConditionalExpression(value)) return pure(value.condition, values)
      && pure(value.whenTrue, values) && pure(value.whenFalse, values);
    if (ts.isElementAccessExpression(value)) return value.argumentExpression !== undefined
      && pure(value.expression, values) && pure(value.argumentExpression, values);
    if (ts.isPropertyAccessExpression(value)) return pure(value.expression, values);
    if (ts.isArrayLiteralExpression(value)) return value.elements.every(element =>
      ts.isExpression(element) && pure(element, values));
    if (ts.isObjectLiteralExpression(value)) return value.properties.every(property =>
      ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      && pure(property.initializer, values));
    return false;
  };
  const run = (node: ts.Expression, values: ReadonlySet<string>): boolean => {
    const value = unwrap(node);
    if (!method(value, context, 'run') || value.arguments.length < 1 || value.arguments.length > 2
      || !value.arguments.every(argument => pure(argument, values))) return false;
    runs++;
    return true;
  };
  const group = (node: ts.Expression, values: ReadonlySet<string>, depth: number): boolean => {
    const value = unwrap(node);
    if (!method(value, 'Promise', 'all') || value.arguments.length !== 1 || depth > 4) return false;
    groups++;
    const members = value.arguments[0]!;
    if (ts.isArrayLiteralExpression(members)) {
      if (members.elements.length < 2) return false;
      return members.elements.every(member => {
        if (!ts.isExpression(member)) return false;
        if (run(member, values)) return true;
        const call = unwrap(member);
        if (depth === 0 && ts.isCallExpression(call) && ts.isIdentifier(call.expression)
          && call.arguments.length === 0 && branches.has(call.expression.text)) {
          return branch(branches.get(call.expression.text)!, depth + 1);
        }
        if (depth === 0 && ts.isCallExpression(call) && call.arguments.length === 0
          && ts.isParenthesizedExpression(call.expression) && ts.isArrowFunction(call.expression.expression)) {
          return branch(call.expression.expression, depth + 1);
        }
        return false;
      });
    }
    return false;
  };
  const awaitStep = (node: ts.Expression, values: ReadonlySet<string>, depth: number): boolean => {
    const value = unwrap(node);
    if (!ts.isAwaitExpression(value)) return false;
    return run(value.expression, values) || group(value.expression, values, depth);
  };
  const statements = (block: ts.Block, values: Set<string>, depth: number): boolean => {
    for (const statement of block.statements) {
      if (ts.isExpressionStatement(statement)) {
        if (awaitStep(statement.expression, values, depth)) continue;
        const value = unwrap(statement.expression);
        if (depth === 0 && method(value, context, 'done') && value.arguments.length >= 1
          && value.arguments.every(argument => pure(argument, values))
          && statement === block.statements[block.statements.length - 1]) continue;
        return false;
      }
      if (ts.isReturnStatement(statement) && depth > 0 && statement.expression !== undefined
        && awaitStep(statement.expression, values, depth)) continue;
      if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) return false;
      for (const item of statement.declarationList.declarations) {
        if (!ts.isIdentifier(item.name) || item.initializer === undefined) return false;
        if (['Promise', 'globalThis', 'global'].includes(item.name.text)) return false;
        if (depth === 0 && ts.isArrowFunction(item.initializer)) {
          if (branches.has(item.name.text) || item.initializer.parameters.length !== 0
            || item.initializer.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) !== true
            ) return false;
          branches.set(item.name.text, item.initializer);
          continue;
        }
        if (!awaitStep(item.initializer, values, depth)) return false;
        values.add(item.name.text);
      }
    }
    return true;
  };
  const branch = (arrow: ts.ArrowFunction, depth: number): boolean => {
    if (arrow.parameters.length !== 0) return false;
    const before = runs;
    const valid = ts.isBlock(arrow.body) ? statements(arrow.body, new Set(rootValues), depth)
      : awaitStep(arrow.body, rootValues, depth);
    // An empty async branch creates a join with no causal step predecessor.
    return valid && runs > before;
  };

  if (!statements(expression.body, rootValues, 0)) return false;
  return groups > 0 && runs > 0;
}

/** Reject any source that can change what a free `Promise` identifier means. */
function certifiedModuleBody(source: string, bodySource?: string): string | undefined {
  const file = ts.createSourceFile('authored-module.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  if (((file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length ?? 0) > 0) {
    return undefined;
  }
  // Top-level code can alter the constructor or its methods without binding
  // the name. Leave these modules on the established serial scheduler too.
  const touchesPromiseOutsideDefinition = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node) && ['Promise', 'globalThis', 'global'].includes(node.text)) return true;
    return ts.forEachChild(node, touchesPromiseOutsideDefinition) === true;
  };
  let definesDefaultBody = false;
  let importsSurfaceFlow = false;
  let certifiedBody: string | undefined;
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      // Imports can execute code before the body starts. Only the direct,
      // immutable Surface binding can certify the exported body's identity.
      if (statement.moduleSpecifier.getText(file) !== "'@relayflows/surface'"
        && statement.moduleSpecifier.getText(file) !== '"@relayflows/surface"') return undefined;
      const bindings = statement.importClause?.namedBindings;
      if (statement.importClause?.name !== undefined || bindings === undefined
        || !ts.isNamedImports(bindings) || bindings.elements.length !== 1
        || bindings.elements[0]?.name.text !== 'flow'
        || bindings.elements[0]?.propertyName !== undefined || importsSurfaceFlow) return undefined;
      importsSurfaceFlow = true;
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      // Only the final body argument is allowed to mention Promise.all. Do
      // not let an expression around flow() mutate Promise while we skip it.
      const call = statement.expression;
      if (statement.isExportEquals || !ts.isCallExpression(call)
        || !ts.isIdentifier(call.expression) || call.expression.text !== 'flow') return undefined;
      const args = call.arguments;
      if (args.length !== 2 || !ts.isStringLiteral(args[0]!)) return undefined;
      if (!ts.isArrowFunction(args[args.length - 1]!)) return undefined;
      certifiedBody = args[args.length - 1]!.getText(file);
      if (bodySource !== undefined && certifiedBody !== bodySource) return undefined;
      if (args.slice(0, -1).some(touchesPromiseOutsideDefinition)) return undefined;
      if (definesDefaultBody) return undefined;
      definesDefaultBody = true;
      continue;
    }
    // The certified body cannot use module captures. Other top-level code is
    // unnecessary for it and may schedule a later mutation through an alias.
    return undefined;
  }
  const forbidden = new Set(['Promise', 'globalThis']);
  const bindsForbidden = (name: ts.BindingName): boolean => ts.isIdentifier(name)
    ? forbidden.has(name.text)
    : name.elements.some(element => ts.isBindingElement(element) && bindsForbidden(element.name));
  const isGlobalPromise = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) return forbidden.has(node.text);
    if (ts.isPropertyAccessExpression(node)) return ts.isIdentifier(node.expression)
      && node.expression.text === 'globalThis' && node.name.text === 'Promise';
    return ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'globalThis' && ts.isStringLiteral(node.argumentExpression)
      && node.argumentExpression.text === 'Promise';
  };
  let unsafe = false;
  const visit = (node: ts.Node): void => {
    if (unsafe) return;
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node))
      && bindsForbidden(node.name)) unsafe = true;
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
      || ts.isClassDeclaration(node) || ts.isClassExpression(node)
      || ts.isEnumDeclaration(node) || ts.isImportEqualsDeclaration(node)
      || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node))
      && node.name !== undefined && forbidden.has(node.name.text)) unsafe = true;
    if (ts.isImportClause(node) && node.name !== undefined && forbidden.has(node.name.text)) unsafe = true;
    if (ts.isNamespaceImport(node) && forbidden.has(node.name.text)) unsafe = true;
    if (ts.isImportSpecifier(node) && forbidden.has(node.name.text)) unsafe = true;
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && isGlobalPromise(node.left)) unsafe = true;
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && isGlobalPromise(node.operand)) unsafe = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  // The body may come from another module, where a free Promise name can be
  // shadowed without appearing in this source. In that case use serial IDs.
  return importsSurfaceFlow && definesDefaultBody && !unsafe ? certifiedBody : undefined;
}
