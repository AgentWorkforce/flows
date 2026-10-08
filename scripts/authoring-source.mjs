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
  return file.statements.filter(ts.isExportDeclaration).flatMap(node => {
    if (node.exportClause && ts.isNamedExports(node.exportClause)) return node.exportClause.elements.map(item => item.name.text);
    // `export * from './x.js'` re-exports everything x exports; follow it.
    return starModule(file, node) === undefined ? [] : exportedNames(source(starModule(file, node)));
  });
}

/**
 * The package's public types: type-only named exports, and the interfaces and
 * type aliases a `export *` module exports, each with the file to resolve it from.
 */
export function typeExports(file) {
  return file.statements.filter(ts.isExportDeclaration).flatMap(node => {
    if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      return node.exportClause.elements.filter(item => node.isTypeOnly || item.isTypeOnly).map(item => ({ name: item.name.text, from: file.fileName }));
    }
    const star = starModule(file, node);
    if (star === undefined) return [];
    const module = source(star);
    const own = module.statements.filter(statement => (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
      && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)).map(statement => ({ name: statement.name.text, from: star }));
    return [...own, ...typeExports(module)];
  });
}

/** The local file behind `export * from "./x.js"`, for .ts sources and emitted .d.ts alike. */
export function starModule(file, node) {
  if (node.exportClause || !node.moduleSpecifier || !node.moduleSpecifier.text.startsWith('.')) return undefined;
  const base = resolve(dirname(file.fileName), node.moduleSpecifier.text.replace(/\.js$/, ''));
  return file.fileName.endsWith('.d.ts') ? `${base}.d.ts` : `${base}.ts`;
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

/** Type names referenced from declaration text, in first-seen order. */
export function typeReferences(text) {
  const file = source('references.ts', text);
  const names = [];
  const visit = node => {
    if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node) || ts.isTypeQueryNode(node)) {
      // `typeof githubClient` names a value whose type the declaration depends on.
      const target = ts.isTypeReferenceNode(node) ? node.typeName : ts.isTypeQueryNode(node) ? node.exprName : node.expression;
      let left = target;
      while (ts.isQualifiedName(left)) left = left.left;
      while (ts.isPropertyAccessExpression(left)) left = left.expression;
      if (ts.isIdentifier(left) && !names.includes(left.text)) names.push(left.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

/** Exported name -> relative module that declares it, from the package index. */
export function exportSources(index) {
  const result = new Map();
  for (const node of index.statements) {
    if (!ts.isExportDeclaration(node) || !node.moduleSpecifier || !node.exportClause || !ts.isNamedExports(node.exportClause)) continue;
    for (const item of node.exportClause.elements) result.set(item.name.text, node.moduleSpecifier.text);
  }
  return result;
}

/**
 * The callable surface of an implemented export, without its body: a function
 * declaration's signature, or the methods of an `Object.freeze({...})` value.
 * Parameter defaults read as optional parameters, as they do to a caller.
 */
export function signatureText(file, name) {
  const parameters = node => node.parameters.map(parameter => `${parameter.name.getText(file)}${parameter.questionToken || parameter.initializer ? '?' : ''}: ${parameter.type.getText(file)}`).join(', ');
  const docs = node => ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc).map(doc => doc.getText(file)).join('\n');
  const signature = node => {
    if (!node.type) throw new Error(`${file.fileName}: ${node.name.getText(file)} needs an explicit return type to be documented`);
    const generics = node.typeParameters ? `<${node.typeParameters.map(item => item.getText(file)).join(', ')}>` : '';
    return `${node.name.getText(file)}${generics}(${parameters(node)}): ${node.type.getText(file)};`;
  };
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      const doc = docs(statement);
      return `${doc ? `${doc}\n` : ''}export function ${signature(statement)}`;
    }
    if (!ts.isVariableStatement(statement)) continue;
    const declaration = statement.declarationList.declarations.find(item => item.name.getText(file) === name);
    if (!declaration) continue;
    const call = declaration.initializer;
    const object = call && ts.isCallExpression(call) && call.expression.getText(file) === 'Object.freeze' ? call.arguments[0] : undefined;
    if (!object || !ts.isObjectLiteralExpression(object)) throw new Error(`${file.fileName}: ${name} is not a frozen object of methods`);
    const methods = object.properties.map(method => {
      if (!ts.isMethodDeclaration(method)) throw new Error(`${file.fileName}: ${name}.${method.name?.getText(file)} is not a method`);
      const doc = docs(method);
      return `${doc ? `  ${doc}\n` : ''}  ${signature(method)}`;
    });
    const doc = docs(statement);
    return `${doc ? `${doc}\n` : ''}export const ${name}: Readonly<{\n${methods.join('\n')}\n}>;`;
  }
  throw new Error(`${file.fileName}: missing implemented export ${name}`);
}
