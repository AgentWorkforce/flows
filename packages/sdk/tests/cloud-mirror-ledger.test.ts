import { mkdtemp, readFile, readdir, stat, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readMirroredRun, recordMirroredRun, LEDGER_DIRECTORY, LEDGER_MAX_AGE_MS, LEDGER_MAX_ENTRIES,
} from '../src/cloud-mirror-ledger.js';

const CLOUD = 'https://agentrelay.com/cloud';

async function dataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mirror-ledger-'));
}

describe('the mirror ledger', () => {
  it('remembers which Cloud run mirrored a journal, across processes', async () => {
    const dir = await dataDir();
    await recordMirroredRun(dir, '01JOURNAL', { cloudRunId: 'cloud-1', apiUrl: CLOUD });
    await expect(readMirroredRun(dir, '01JOURNAL', CLOUD)).resolves.toBe('cloud-1');
  });

  it('never writes a credential — there is nothing in it to steal', async () => {
    const dir = await dataDir();
    await recordMirroredRun(dir, '01JOURNAL', { cloudRunId: 'cloud-1', apiUrl: CLOUD });
    const entry = await readFile(join(dir, LEDGER_DIRECTORY, '01JOURNAL.json'), 'utf8');

    expect(JSON.parse(entry)).toEqual({ cloudRunId: 'cloud-1', apiUrl: CLOUD });
    expect(entry).not.toMatch(/cld_at_|cld_rt_|token/iu);
    // Readable only by its owner: it names runs in someone's workspace, and a
    // shared machine should not publish that.
    expect((await stat(join(dir, LEDGER_DIRECTORY, '01JOURNAL.json'))).mode & 0o077).toBe(0);
  });

  it('refuses an entry written for another deployment', async () => {
    const dir = await dataDir();
    await recordMirroredRun(dir, '01JOURNAL', { cloudRunId: 'cloud-1', apiUrl: 'https://staging.example.com/cloud' });
    // A run mirrored to staging must not claim to continue an id that means
    // something else in production — or nothing at all there.
    await expect(readMirroredRun(dir, '01JOURNAL', CLOUD)).resolves.toBeUndefined();
    await expect(readMirroredRun(dir, '01JOURNAL', 'https://staging.example.com/cloud')).resolves.toBe('cloud-1');
  });

  it('answers nothing rather than throwing for anything it cannot use', async () => {
    const dir = await dataDir();
    await mkdir(join(dir, LEDGER_DIRECTORY), { recursive: true });
    await writeFile(join(dir, LEDGER_DIRECTORY, '01BROKEN.json'), 'not json at all');
    await writeFile(join(dir, LEDGER_DIRECTORY, '01EMPTY.json'), '{}');

    await expect(readMirroredRun(dir, '01BROKEN', CLOUD)).resolves.toBeUndefined();
    await expect(readMirroredRun(dir, '01EMPTY', CLOUD)).resolves.toBeUndefined();
    await expect(readMirroredRun(dir, '01MISSING', CLOUD)).resolves.toBeUndefined();
    await expect(readMirroredRun('/nonexistent/data/dir', '01JOURNAL', CLOUD)).resolves.toBeUndefined();
  });

  it('refuses a run id that is not a path component', async () => {
    const dir = await dataDir();
    await recordMirroredRun(dir, '../escape', { cloudRunId: 'cloud-1', apiUrl: CLOUD });
    await expect(readMirroredRun(dir, '../escape', CLOUD)).resolves.toBeUndefined();
    await expect(readdir(join(dir, LEDGER_DIRECTORY)).catch(() => [])).resolves.toEqual([]);
  });

  it('drops entries past their age, so the directory does not grow forever', async () => {
    const dir = await dataDir();
    await recordMirroredRun(dir, '01OLD', { cloudRunId: 'cloud-old', apiUrl: CLOUD });
    const stale = new Date(Date.now() - LEDGER_MAX_AGE_MS - 60_000);
    await utimes(join(dir, LEDGER_DIRECTORY, '01OLD.json'), stale, stale);

    // Any later write prunes.
    await recordMirroredRun(dir, '01NEW', { cloudRunId: 'cloud-new', apiUrl: CLOUD });

    await expect(readMirroredRun(dir, '01OLD', CLOUD)).resolves.toBeUndefined();
    await expect(readMirroredRun(dir, '01NEW', CLOUD)).resolves.toBe('cloud-new');
  });

  it('keeps the newest entries when the count cap bites', async () => {
    const dir = await dataDir();
    for (let index = 0; index < LEDGER_MAX_ENTRIES + 5; index += 1) {
      await recordMirroredRun(dir, `J${String(index).padStart(5, '0')}`, {
        cloudRunId: `cloud-${index}`, apiUrl: CLOUD,
      });
    }
    const kept = await readdir(join(dir, LEDGER_DIRECTORY));
    expect(kept.length).toBeLessThanOrEqual(LEDGER_MAX_ENTRIES);
    // The most recent write survives; that is the one a resume would want.
    await expect(readMirroredRun(dir, `J${String(LEDGER_MAX_ENTRIES + 4).padStart(5, '0')}`, CLOUD))
      .resolves.toBe(`cloud-${LEDGER_MAX_ENTRIES + 4}`);
  }, 60_000);
});
