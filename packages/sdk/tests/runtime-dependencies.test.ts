import { builtinModules } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, type Node, type AnyNode } from 'acorn';
import { expect, it } from 'vitest';

const sdk = fileURLToPath(new URL('..', import.meta.url));
const builtins = new Set(builtinModules);

it('declares every literal runtime import in the built SDK', () => {
  const manifest = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8'));
  const declared = new Set(Object.keys({
    ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies,
  }));
  const missing = new Set<string>();
  let files = 0;
  function specifier(value: unknown) {
    if (typeof value !== 'string' || /^(\.|\/|node:)/.test(value) || builtins.has(value)) return;
    const name = value.startsWith('@') ? value.split('/').slice(0, 2).join('/') : value.split('/')[0]!;
    if (!declared.has(name)) missing.add(name);
  }
  // Computed imports/require calls cannot be checked by a literal AST scan.
  function walk(node: Node) {
    const n = node as AnyNode;
    if (n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' ||
      n.type === 'ExportAllDeclaration' || n.type === 'ImportExpression') {
      if (n.source?.type === 'Literal') specifier(n.source.value);
    }
    if (n.type === 'CallExpression' && (
      (n.callee.type === 'Identifier' && n.callee.name === 'require') ||
      (n.callee.type === 'MemberExpression' && !n.callee.computed &&
        n.callee.object.type === 'Identifier' && n.callee.object.name === 'require' &&
        n.callee.property.type === 'Identifier' && n.callee.property.name === 'resolve'))) {
      if (n.arguments[0]?.type === 'Literal') specifier(n.arguments[0].value);
    }
    for (const value of Object.values(n)) {
      if (Array.isArray(value)) value.forEach(child => { if (child?.type) walk(child); });
      else if (value && typeof value === 'object' && 'type' in value) walk(value as Node);
    }
  }
  function scan(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.name.endsWith('.js')) {
        files++;
        walk(parse(readFileSync(path, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' }));
      }
    }
  }
  scan(join(sdk, 'dist'));
  expect(files, 'Build the SDK before checking runtime dependencies').toBeGreaterThan(0);
  expect([...missing].sort(), 'Undeclared runtime dependencies').toEqual([]);
});
