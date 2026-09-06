// Drop the build outputs a test run does not need, to keep the propagated
// tree small in a cloud sandbox.
//
// Source maps only. Declaration files are deliberately NOT pruned: package.json
// declares `"types": "./dist/index.d.ts"`, so deleting them would leave the
// package's own declared type entry pointing at a file that `npm test` had just
// removed. Nothing in this repo breaks today -- every current in-repo consumer
// imports `.js` (`ops/probes/**`, `workflows/drive.yaml`,
// `workflows/drive-cloud.yaml`, `testdata/backlog-picker.flow.yaml`), and
// `surface` does not depend on the sdk -- but the next TypeScript consumer
// would hit a failure whose cause is "someone ran the tests", which is not a
// cost worth paying for the space. The file
// count that actually matters is `kernel/target/debug` at ~4900 files (see
// ops/cargo.sh); `dist` declarations are noise beside it.
import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const generatedDirectories = [resolve(import.meta.dirname, "../dist")];

for (const directory of generatedDirectories) {
  let entries;
  try {
    entries = await readdir(directory, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }

  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith(".map"),
      )
      .map((entry) => rm(resolve(entry.parentPath, entry.name))),
  );
}
