import { createRequire } from 'node:module';
import Ajv from 'ajv';
import AjvDraft4 from 'ajv-draft-04';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';

const require = createRequire(import.meta.url);
const draft6MetaSchema = require('ajv/dist/refs/json-schema-draft-06.json') as Record<string, unknown>;

const DRAFT_4 = 'http://json-schema.org/draft-04/schema';
const DRAFT_6 = 'http://json-schema.org/draft-06/schema';
const DRAFT_7 = 'http://json-schema.org/draft-07/schema';
const DRAFT_2019_09 = 'https://json-schema.org/draft/2019-09/schema';
const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

/** Compile a declaration with the same drafts accepted by the kernel. */
export function jsonSchemaError(schema: Record<string, unknown>): string | undefined {
  try {
    const dialect = typeof schema['$schema'] === 'string'
      ? schema['$schema'].replace(/#$/, '')
      : DRAFT_2020_12;
    const options = { strict: false, allErrors: true } as const;
    if (dialect === DRAFT_4) {
      new AjvDraft4(options).compile(schema);
    } else if (dialect === DRAFT_6) {
      const validator = new Ajv(options);
      validator.addMetaSchema(draft6MetaSchema);
      validator.compile(schema);
    } else if (dialect === DRAFT_7) {
      new Ajv(options).compile(schema);
    } else if (dialect === DRAFT_2019_09) {
      new Ajv2019(options).compile(schema);
    } else {
      // Ajv reports unknown dialect identifiers instead of guessing.
      new Ajv2020(options).compile(schema);
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
