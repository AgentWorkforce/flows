// Bundle the SDK's official Ajv meta-schemas as local 2020-12 definitions.
// This validates embedded schema keyword shapes offline. Reference resolution
// and termination of author-provided schemas remain the SDK/kernel's job.
export function outputMetaschemas(require) {
  const drafts = [
    ['04', 'ajv-draft-04/dist/refs/json-schema-draft-04.json'],
    ['06', 'ajv/dist/refs/json-schema-draft-06.json'],
    ['07', 'ajv/dist/refs/json-schema-draft-07.json'],
    ['2019', 'ajv/dist/refs/json-schema-2019-09/schema.json'],
    ['2020', 'ajv/dist/refs/json-schema-2020-12/schema.json'],
  ];
  const documents = new Map();
  const roots = new Map();
  const ids = new Map();
  for (const [draft, path] of drafts) {
    const root = require(path);
    const key = `Meta${draft}`;
    const uri = (root.$id ?? root.id).replace(/#$/, '');
    documents.set(key, { root, base: uri, draft });
    roots.set(draft, key);
    ids.set(uri, key);
    if (draft === '2019' || draft === '2020') {
      const vocabularies = Object.keys(root.$vocabulary).map(uri => uri.split('/').at(-1));
      for (const vocabulary of vocabularies) {
        const meta = require(path.replace('schema.json', `meta/${vocabulary}.json`));
        const name = `${key}_${vocabulary}`;
        documents.set(name, { root: meta, base: meta.$id, draft });
        ids.set(meta.$id, name);
      }
    }
  }
  function convert(value, base, draft) {
    if (Array.isArray(value)) return value.map(child => convert(child, base, draft));
    if (value === null || typeof value !== 'object') return value;
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (['$schema', '$id', 'id', '$vocabulary', '$anchor', '$dynamicAnchor', '$recursiveAnchor', 'format'].includes(key)) continue;
      if (key === '$dynamicRef' || key === '$recursiveRef') {
        result.$ref = `#/$defs/${roots.get(draft)}`;
      } else if (key === '$ref') {
        const target = new URL(child, base);
        const fragment = target.hash;
        target.hash = '';
        const name = ids.get(target.href);
        if (!name) throw new Error(`Unbundled meta-schema reference ${target.href}`);
        result.$ref = `#/$defs/${name}${fragment.startsWith('#/') ? fragment.slice(1) : ''}`;
      } else if (key === 'dependencies') {
        result.dependentRequired = child;
      } else if (['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].includes(key)) {
        result[key] = Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, convert(schema, base, draft)]));
      } else if (['items', 'additionalItems', 'additionalProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key)) {
        result[key] = convert(child, base, draft);
      } else result[key] = child;
    }
    // Draft-04's meta-schema itself uses boolean exclusiveMinimum.
    if (result.exclusiveMinimum === true) {
      result.exclusiveMinimum = result.minimum;
      delete result.minimum;
    }
    return result;
  }
  const defs = Object.fromEntries([...documents].map(([key, { root, base, draft }]) => [key, convert(root, base, draft)]));
  defs.OutputSchema = {
    title: 'Output JSON Schema',
    description: 'Schema declaration using SDK-supported drafts 04, 06, 07, 2019-09 or 2020-12 (default). Run flows check to resolve references and prove termination.',
    type: ['object', 'boolean'],
    properties: { $schema: { type: 'string', enum: drafts.flatMap(([draft]) => { const uri = documents.get(roots.get(draft)).base; return [uri, `${uri}#`]; }) } },
    allOf: drafts.map(([draft]) => {
      const root = documents.get(roots.get(draft)).base;
      const condition = { type: 'object', properties: { $schema: { enum: [root, `${root}#`] } }, required: ['$schema'] };
      return { if: draft === '2020' ? { anyOf: [condition, { not: { type: 'object', required: ['$schema'] } }] } : condition, then: { $ref: `#/$defs/${roots.get(draft)}` } };
    }),
  };
  return defs;
}
