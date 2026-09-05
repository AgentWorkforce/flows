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
          entry.isFile() &&
          (entry.name.endsWith(".map") || entry.name.endsWith(".d.ts")),
      )
      .map((entry) => rm(resolve(entry.parentPath, entry.name))),
  );
}
