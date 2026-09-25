// Which Cloud run mirrored which journal, remembered between invocations.
//
// A journal outlives the process that started it: `flows run` parks on an
// `f.human`, exits, and some time later a different `flows resume` picks the
// same journal up. Cloud models that second attempt as its own run row — its
// own hosted resume mints a fresh run id too — so a parked-then-resumed flow
// is two rows however it is driven. What made that read as two *unrelated*
// pieces of work was that the resuming process had no idea the first attempt
// existed: nothing on disk connected the journal to the Cloud run mirroring
// it, so the second registration could not name its predecessor.
//
// This is that connection, and deliberately nothing more.
//
// ## What is stored, and what is not
//
// The run id and the deployment that issued it. **Never the credential.** The
// run token can write this run's steps and read the workspace's runs; leaving
// one in a dotfile under a developer's home directory, for every run they
// have ever started, would be a worse trade than the feature is worth. A
// resume mints its own credential the same way the first attempt did — the
// registration request it already makes.
//
// So an entry is not a capability. Everything in it is already in the URL the
// first attempt printed to the terminal.
//
// ## Failure is not an error
//
// Every operation here is best-effort and silent. A missing entry means the
// resumed run registers without naming a predecessor, which is exactly what
// happened before this file existed; an unreadable or corrupt one means the
// same. A mirror is an observer, and bookkeeping for an observer must never
// be able to fail a run.

import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Where the ledger lives, beside the journals it describes. */
export const LEDGER_DIRECTORY = 'cloud-runs';
/**
 * How long an entry is worth keeping.
 *
 * A resume of a two-week-old parked run is a real thing; a resume of a run
 * from last quarter is not the case this serves, and a ledger that only grows
 * is a directory nobody ever looks at filling up forever.
 */
export const LEDGER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
/** Entries kept. Past it, the oldest are dropped on the next write. */
export const LEDGER_MAX_ENTRIES = 500;

/** One journal's mirror, as the ledger records it. */
export interface LedgerEntry {
  /** Cloud's run id for the attempt that mirrored this journal. */
  cloudRunId: string;
  /** The deployment that issued it; an entry from another one is not this one's. */
  apiUrl: string;
}

const JOURNAL_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const CLOUD_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/u;

function entryPath(dataDir: string, journalRunId: string): string {
  return join(resolve(dataDir), LEDGER_DIRECTORY, `${journalRunId}.json`);
}

/**
 * Record that `journalRunId` is mirrored by `entry.cloudRunId`.
 *
 * Written with mode 0600 for the same reason the journals are private: it
 * names runs in someone's workspace, and a shared machine should not publish
 * that. It is not a secret — there is nothing here to steal — but it is
 * nobody else's business either.
 */
export async function recordMirroredRun(
  dataDir: string,
  journalRunId: string,
  entry: LedgerEntry,
): Promise<void> {
  if (!JOURNAL_RUN_ID.test(journalRunId) || !CLOUD_RUN_ID.test(entry.cloudRunId)) return;
  const directory = join(resolve(dataDir), LEDGER_DIRECTORY);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      entryPath(dataDir, journalRunId),
      JSON.stringify({ cloudRunId: entry.cloudRunId, apiUrl: entry.apiUrl }),
      { mode: 0o600 },
    );
  } catch {
    // A resume that cannot name its predecessor is the behaviour this file
    // improves on, not a failure of the run.
    return;
  }
  await prune(directory);
}

/**
 * The Cloud run mirroring this journal, if one is recorded *for this
 * deployment*.
 *
 * The deployment check is not bookkeeping. A developer who ran a flow against
 * staging and resumes it against production must not have the resumed run
 * claim to continue a run id that means something else there — or, worse,
 * nothing at all, which Cloud would refuse and which would read as a bug in
 * the resume rather than in the pairing.
 */
export async function readMirroredRun(
  dataDir: string,
  journalRunId: string,
  apiUrl: string,
): Promise<string | undefined> {
  if (!JOURNAL_RUN_ID.test(journalRunId)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(entryPath(dataDir, journalRunId), 'utf8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const entry = parsed as Record<string, unknown>;
  if (typeof entry['cloudRunId'] !== 'string' || !CLOUD_RUN_ID.test(entry['cloudRunId'])) return undefined;
  if (entry['apiUrl'] !== apiUrl) return undefined;
  return entry['cloudRunId'];
}

/** Drop entries past their age, then past the count. Never throws. */
async function prune(directory: string): Promise<void> {
  try {
    const names = (await readdir(directory)).filter(name => name.endsWith('.json'));
    if (names.length <= LEDGER_MAX_ENTRIES) {
      // Still age out: a data dir that never reaches the count cap would
      // otherwise keep its first entry forever.
      await dropOlderThan(directory, names, Date.now() - LEDGER_MAX_AGE_MS);
      return;
    }
    const ages = await Promise.all(names.map(async name => {
      try {
        return { name, at: (await stat(join(directory, name))).mtimeMs };
      } catch {
        return { name, at: 0 };
      }
    }));
    ages.sort((left, right) => right.at - left.at);
    await Promise.all(ages.slice(LEDGER_MAX_ENTRIES).map(entry =>
      unlink(join(directory, entry.name)).catch(() => undefined)));
    await dropOlderThan(directory, ages.slice(0, LEDGER_MAX_ENTRIES).map(entry => entry.name),
      Date.now() - LEDGER_MAX_AGE_MS);
  } catch {
    return;
  }
}

async function dropOlderThan(directory: string, names: string[], floor: number): Promise<void> {
  await Promise.all(names.map(async name => {
    try {
      if ((await stat(join(directory, name))).mtimeMs < floor) {
        await unlink(join(directory, name));
      }
    } catch {
      return;
    }
  }));
}
