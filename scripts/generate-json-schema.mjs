#!/usr/bin/env node
// Build-time only: use the SDK's existing TypeScript compiler, never load SDK code.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyConstraints } from './schema-constraints.mjs';
import { outputMetaschemas } from './schema-metaschemas.mjs';

const sdkRequire = createRequire(new URL('../packages/sdk/package.json', import.meta.url));
const ts = sdkRequire('typescript');
const source = ts.createSourceFile('spec.ts', readFileSync(new URL('../packages/sdk/src/spec.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const declarations = new Map(source.statements
  .filter(node => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
  .map(node => [node.name.text, node]));
const outputSource = ts.createSourceFile('output-schema.ts', readFileSync(new URL('../packages/sdk/src/output-schema.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
for (const node of outputSource.statements) {
  if (ts.isTypeAliasDeclaration(node) && node.name.text === 'JsonOutputSchema') declarations.set(node.name.text, node);
}
const defs = {};
const ref = name => ({ $ref: `#/$defs/${name}` });
const docs = node => (node.jsDoc ?? []).map(doc => typeof doc.comment === 'string' ? doc.comment : '').filter(Boolean).join('\n\n');
const describe = (schema, title, description) => ({ title, description: description || `${title} in the Relayflows spec.`, ...schema });

function object(members, base = { properties: {}, required: [] }) {
  const properties = { ...base.properties };
  const required = new Set(base.required);
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.type) throw new Error(`Unsupported member: ${member.getText()}`);
    const name = member.name.text;
    properties[name] = describe(type(member.type), name, docs(member));
    if (!member.questionToken) required.add(name);
  }
  return { type: 'object', properties, ...(required.size ? { required: [...required] } : {}), additionalProperties: false };
}

function definition(name) {
  if (defs[name]) return defs[name];
  const node = declarations.get(name);
  if (!node) throw new Error(`Unknown type ${name}`);
  let schema;
  if (ts.isInterfaceDeclaration(node)) {
    let base = { properties: {}, required: [] };
    for (const clause of node.heritageClauses ?? []) {
      for (const parent of clause.types) {
        let inherited;
        if (parent.expression.getText() === 'Omit') {
          inherited = structuredClone(definition(parent.typeArguments[0].getText()));
          const keys = parent.typeArguments[1];
          for (const key of ts.isUnionTypeNode(keys) ? keys.types : [keys]) {
            delete inherited.properties[key.literal.text];
            inherited.required = (inherited.required ?? []).filter(name => name !== key.literal.text);
          }
        } else inherited = definition(parent.expression.getText());
        base = { properties: { ...base.properties, ...inherited.properties }, required: [...new Set([...base.required, ...(inherited.required ?? [])])] };
      }
    }
    schema = object(node.members, base);
  } else schema = type(node.type);
  defs[name] = describe(schema, name, docs(node));
  return defs[name];
}

function type(node) {
  if (ts.isParenthesizedTypeNode(node)) return type(node.type);
  if (ts.isArrayTypeNode(node)) return { type: 'array', items: type(node.elementType) };
  if (ts.isTypeLiteralNode(node)) return object(node.members);
  if (ts.isLiteralTypeNode(node)) {
    if (ts.isStringLiteral(node.literal)) return { type: 'string', const: node.literal.text };
    if (ts.isNumericLiteral(node.literal)) return { type: 'number', const: Number(node.literal.text) };
    throw new Error(`Unsupported literal ${node.getText()}`);
  }
  if (ts.isUnionTypeNode(node)) {
    const variants = node.types.map(type);
    if (variants.every(value => value.type === 'string' && 'const' in value)) return { type: 'string', enum: variants.map(value => value.const) };
    return { oneOf: variants };
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText();
    if (name === 'Array') return { type: 'array', items: type(node.typeArguments[0]) };
    if (name === 'Record') {
      if (node.typeArguments[0].kind !== ts.SyntaxKind.StringKeyword) throw new Error('Only string-keyed maps are supported');
      return { type: 'object', additionalProperties: type(node.typeArguments[1]) };
    }
    definition(name);
    return ref(name);
  }
  const primitives = { [ts.SyntaxKind.StringKeyword]: 'string', [ts.SyntaxKind.NumberKeyword]: 'number', [ts.SyntaxKind.BooleanKeyword]: 'boolean' };
  if (primitives[node.kind]) return { type: primitives[node.kind] };
  if (node.kind === ts.SyntaxKind.UnknownKeyword) return {};
  throw new Error(`Unsupported type ${node.getText()}`);
}

for (const name of declarations.keys()) definition(name);
const versionNode = source.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText() === 'SPEC_SCHEMA_VERSION');
if (!versionNode || !ts.isStringLiteral(versionNode.initializer)) throw new Error('Missing literal SPEC_SCHEMA_VERSION');
const version = versionNode.initializer.text;
applyConstraints(defs, version);
Object.assign(defs, outputMetaschemas(sdkRequire));
const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `https://schema.relayflows.dev/v${version.split('.').slice(0, 2).join('.')}/flows.schema.json`,
  title: 'Relayflow',
  description: 'Relayflows YAML/JSON authoring spec. Run flows check for cross-step references, dependency cycles, schema-reference termination, and environment readiness.',
  $ref: '#/$defs/FlowSpec',
  $defs: defs,
};

// Annotate every schema node, including items, union arms and open maps. Do not
// walk examples/defaults as schemas: their values are author data.
function annotate(node, title) {
  if (typeof node !== 'object' || node === null) return;
  node.title ??= title;
  node.description ??= node.$ref ? `See ${node.$ref.split('/').at(-1)}.` : `${title} value.`;
  for (const key of ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas']) {
    for (const [name, child] of Object.entries(node[key] ?? {})) annotate(child, name);
  }
  for (const key of ['items', 'contains', 'additionalProperties', 'propertyNames', 'not', 'if', 'then', 'else']) annotate(node[key], `${title} ${key}`);
  for (const key of ['oneOf', 'anyOf', 'allOf', 'prefixItems']) (node[key] ?? []).forEach((child, index) => annotate(child, `${title} alternative ${index + 1}`));
}
annotate(schema, 'Relayflow');
const destination = process.argv[2] ?? fileURLToPath(new URL('../packages/schema/flows.schema.json', import.meta.url));
writeFileSync(destination, `${JSON.stringify(schema, null, 2)}\n`);
console.log(`Generated packages/schema/flows.schema.json (${Object.keys(defs).length} definitions)`);
