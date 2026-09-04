import { writeFileSync } from 'node:fs';
import { flow } from '@relayflows/surface';

const importMarker = process.env['RELAYFLOWS_TEST_IMPORT_MARKER'];
if (importMarker !== undefined) writeFileSync(importMarker, 'authored module imported');

export default flow('pre-journal-side-effect', async (f, input: { marker: string }) => {
  writeFileSync(input.marker, 'authored body ran');
  await f.run('true');
  f.done('success');
});
