import { describe, expect, it } from 'vitest';
import { pollDirectoryOnce, type DirLister } from '../src/dir-watcher-poller.js';

function recordingSink() {
  const submitted: Array<{ spec: unknown; event: { type: string; payload?: unknown } }> = [];
  return {
    submitted,
    async eventSubmit(spec: unknown, event: { type: string; payload?: unknown }) {
      submitted.push({ spec, event });
      return { matched: true, deduped: false };
    },
  };
}

const listerFor = (files: Array<{ name: string; size?: number; mtimeMs?: number }>): DirLister =>
  async () => files.map((f) => ({
    name: f.name,
    size: f.size ?? 100,
    mtimeMs: f.mtimeMs ?? Date.now(),
    isFile: true,
  }));

describe('dir-watcher poller', () => {
  it('submits one event per NEW file and adds it to the seen set', async () => {
    const sink = recordingSink();
    const seen = new Set<string>();
    const spec = { name: 'dir-watcher' };

    await pollDirectoryOnce(spec, sink, {
      dir: '/tmp/watch',
      seen,
      lister: listerFor([{ name: 'a.txt' }, { name: 'b.log' }]),
    });

    expect(sink.submitted).toHaveLength(2);
    expect(sink.submitted[0].event.type).toBe('dir.file_appeared');
    expect((sink.submitted[0].event.payload as any).path).toBe('a.txt');
    expect((sink.submitted[0].event.payload as any).type).toBe('file');
    expect(seen.has('a.txt')).toBe(true);
    expect(seen.has('b.log')).toBe(true);
  });

  it('does NOT re-submit files already in the seen set', async () => {
    const sink = recordingSink();
    const seen = new Set(['a.txt']);

    await pollDirectoryOnce({}, sink, {
      dir: '/tmp/watch',
      seen,
      lister: listerFor([{ name: 'a.txt' }, { name: 'b.log' }]),
    });

    // Only b.log is new.
    expect(sink.submitted).toHaveLength(1);
    expect((sink.submitted[0].event.payload as any).path).toBe('b.log');
  });

  it('does NOT add a file to `seen` if its eventSubmit throws (retry on next poll)', async () => {
    const seen = new Set<string>();
    let attempts = 0;
    const sink = {
      async eventSubmit() {
        attempts++;
        throw new Error('journal client: connection closed');
      },
    };

    await expect(pollDirectoryOnce({}, sink, {
      dir: '/tmp/watch',
      seen,
      lister: listerFor([{ name: 'a.txt' }]),
    })).rejects.toThrow(/journal client/);

    expect(attempts).toBe(1);
    // The file did NOT enter seen — the next poll must retry.
    expect(seen.has('a.txt')).toBe(false);
  });

  it('respects the fileLimit cap', async () => {
    const sink = recordingSink();
    const seen = new Set<string>();
    const files = Array.from({ length: 25 }, (_, i) => ({ name: `f${i}.txt` }));

    await pollDirectoryOnce({}, sink, {
      dir: '/tmp/watch',
      seen,
      lister: listerFor(files),
      fileLimit: 10,
    });

    expect(sink.submitted).toHaveLength(10);
    // Only the first 10 got submitted; the remaining 15 are still un-seen.
    expect(seen.size).toBe(10);
  });

  it('propagates a lister error (missing directory, permission denied)', async () => {
    const sink = recordingSink();
    const seen = new Set<string>();

    await expect(pollDirectoryOnce({}, sink, {
      dir: '/nonexistent',
      seen,
      lister: async () => { throw new Error('ENOENT: no such directory'); },
    })).rejects.toThrow(/ENOENT/);

    expect(sink.submitted).toHaveLength(0);
  });

  it('carries file metadata (size + mtime) in the event payload', async () => {
    const sink = recordingSink();
    const seen = new Set<string>();

    await pollDirectoryOnce({}, sink, {
      dir: '/tmp/watch',
      seen,
      lister: listerFor([{ name: 'a.txt', size: 4096, mtimeMs: 1717000000000 }]),
    });

    const payload = sink.submitted[0].event.payload as any;
    expect(payload.path).toBe('a.txt');
    expect(payload.size).toBe(4096);
    expect(payload.mtime_ms).toBe(1717000000000);
  });
});
