import { writeFile } from 'node:fs/promises';
import { exportBabysitterCatalogBundle } from '../dist/babysitter-catalog-export.js';

const [ref, digest, manifestSha256, output, ...extra] = process.argv.slice(2);
try {
  if (!ref || !digest || !manifestSha256 || !output || extra.length) {
    throw new Error('Usage: node packages/sdk/scripts/export-babysitter-catalog.mjs REF DIGEST MANIFEST_SHA256 OUTPUT.json');
  }
  const bundle = await exportBabysitterCatalogBundle({ ref, digest, manifestSha256 });
  // Never truncate a prior artifact, and never create output on validation failure.
  await writeFile(output, JSON.stringify(bundle, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(`Exported ${bundle.name}@${bundle.version} ${bundle.ref} sha256:${bundle.digest}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
