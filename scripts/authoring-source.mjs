import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
let ts;
try {
  ts = createRequire(resolve(root, 'packages/surface/package.json'))('typescript');
} catch {
  throw new Error('Install reference tooling first: cd packages/surface && bun install --frozen-lockfile --ignore-scripts');
}
export { ts };
export function source(file, text = readFileSync(file, 'utf8')) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}
export function declarations(file, name) {
  const nodes = file.statements.filter(node => node.name?.text === name
    && !(ts.isFunctionDeclaration(node) && node.body));
  if (!nodes.length) throw new Error(`${file.fileName}: missing declaration ${name}`);
  return nodes;
}
export function declarationText(file, name) {
  return declarations(file, name).map(node => file.text.slice(node.getFullStart(), node.end).trim()).join('\n');
}
export function unionDeclarations(file, name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const nodes = declarations(file, name);
  const result = [declarationText(file, name)];
  for (const node of nodes) {
    if (ts.isTypeAliasDeclaration(node)) {
      const visit = type => {
        if (ts.isUnionTypeNode(type)) type.types.forEach(visit);
        else if (ts.isTypeReferenceNode(type)) result.push(...unionDeclarations(file, type.typeName.getText(file), seen));
        else throw new Error(`${file.fileName}: unsupported union member ${type.getText(file)}`);
      };
      visit(node.type);
    }
  }
  return result;
}
export function exportedNames(file) {
  return file.statements.filter(ts.isExportDeclaration).flatMap(node =>
    node.exportClause && ts.isNamedExports(node.exportClause)
      ? node.exportClause.elements.map(item => item.name.text) : []);
}

/** Read static documentation data without executing SDK imports or environment-dependent defaults. */
export function literal(file, name, importDepth = 0, stack = []) {
  const key = `${file.fileName}:${name}`;
  if (stack.includes(key)) throw new Error(`${key}: cyclic literal reference`);
  const chain = [...stack, key];
  const fail = node => { throw new Error(`${chain.join(' -> ')}: unresolved literal ${node.getText(file)}`); };
  function read(node) {
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return read(node.expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isIdentifier(node)) return literal(file, node.text, importDepth, chain);
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(item => {
      if (!ts.isSpreadElement(item)) return [read(item)];
      const value = read(item.expression);
      if (!Array.isArray(value)) return fail(item);
      return value;
    });
    if (ts.isObjectLiteralExpression(node)) {
      const result = {};
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) return fail(property);
        const field = property.name.text;
        // Parser variant bookkeeping is not a rendered CLI field.
        if (field === 'variants') continue;
        try { result[field] = read(property.initializer); }
        catch (error) { throw new Error(`${file.fileName}: ${result.name ?? name}.${field}: ${error.message}`); }
      }
      return result;
    }
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'String' && node.arguments.length === 1) {
      const value = read(node.arguments[0]);
      if (!['string', 'number', 'boolean'].includes(typeof value)) return fail(node);
      return String(value);
    }
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => {
      const value = read(span.expression);
      if (!['string', 'number', 'boolean'].includes(typeof value)) return fail(span.expression);
      return String(value) + span.literal.text;
    }).join('');
    return fail(node);
  }
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations.find(item => item.name.getText(file) === name);
      if (declaration?.initializer) return read(declaration.initializer);
    }
    if (ts.isImportDeclaration(statement) && importDepth === 0) {
      const bindings = statement.importClause?.namedBindings;
      const binding = bindings && ts.isNamedImports(bindings) && bindings.elements.find(item => item.name.text === name);
      if (binding && statement.moduleSpecifier.text.startsWith('.')) {
        const imported = resolve(dirname(file.fileName), statement.moduleSpecifier.text.replace(/\.js$/, '.ts'));
        return literal(source(imported), binding.propertyName?.text ?? name, importDepth + 1, chain);
      }
    }
  }
  throw new Error(`${chain.join(' -> ')}: unresolved literal identifier ${name}`);
}
