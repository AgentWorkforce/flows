import { writeFileSync } from 'node:fs';
import { flow } from '@relayflows/surface';

// The test asserts the AUTHORED BODY does not run before daemon
// availability. Trigger preflight requires importing the module (see
// checkAuthoredTriggers in cli/check-triggers.ts) so an import-time
// side effect is allowed and, if the caller supplies
// RELAYFLOWS_TEST_IMPORT_MARKER, recorded — the body-run marker is
// distinct so the daemon-not-imported contract still has teeth.
const importMarker = process.env['RELAYFLOWS_TEST_IMPORT_MARKER'];
if (importMarker !== undefined) writeFileSync(importMarker, 'authored module imported');

export default flow('pre-journal-side-effect', async (f, input: { marker: string }) => {
  writeFileSync(input.marker, 'authored body ran');
  await f.run('true');
  f.done('success');
});
