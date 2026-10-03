import { isBuiltin } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Parse syntax, not text: examples and comments can contain pretend imports.
function runtimeSpecifiers(source: string): string[] {
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  function visit(node: ts.Node): void {
    let specifier: ts.Node | undefined;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (clause?.isTypeOnly) return;
      if (!clause?.name && bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every((item) => item.isTypeOnly)) return;
      specifier = node.moduleSpecifier;
    } else if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly) return;
      const clause = node.exportClause;
      if (clause && ts.isNamedExports(clause) && clause.elements.length > 0
        && clause.elements.every((item) => item.isTypeOnly)) return;
      specifier = node.moduleSpecifier;
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      specifier = node.arguments[0];
    }
    if (specifier && ts.isStringLiteral(specifier)) specifiers.push(specifier.text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return specifiers;
}

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path)
      : entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

describe('runtime dependency declarations', () => {
  it('distinguishes runtime edges from type-only syntax and example strings', () => {
    expect(runtimeSpecifiers(`
      import 'side-effect';
      import value, { type T } from 'default';
      import { type T, value } from 'mixed';
      import type { T } from 'types';
      import { type T } from 'inline-types';
      export type { T } from 'export-types';
      export { type T } from 'inline-export-types';
      export { type T, value } from 'mixed-export';
      export * from 're-export';
      const loaded = import('dynamic');
      const example = "import value from 'fake'";
      // import 'comment';
    `)).toEqual(['side-effect', 'default', 'mixed', 'mixed-export', 're-export', 'dynamic']);
  });

  it('declares every literal runtime import in src as a dependency or peer', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }));
    const missing = new Set<string>();
    for (const file of sources(join(root, 'src'))) {
      for (const specifier of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
        if (specifier.startsWith('.') || specifier.startsWith('/') || isBuiltin(specifier)) continue;
        const name = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
        if (!declared.has(name)) missing.add(`${name} (${file.slice(root.length)})`);
      }
    }
    expect([...missing].sort(), 'runtime imports missing dependencies/peerDependencies').toEqual([]);
  });
});
