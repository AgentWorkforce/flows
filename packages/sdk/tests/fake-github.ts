import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FetchLike } from '../src/plugin-github.js';

/**
 * An in-memory stand-in for the three public GitHub reads the SDK performs:
 * commit resolution, recursive tree listing, and raw blob download. Tests
 * shape repositories directly (symlinks, submodules, oversize files, byte
 * drift, truncated trees) so every refusal is exercised offline.
 */
export interface FakeEntry { path: string; data?: Buffer; mode?: string; type?: string; size?: number }
export interface FakeCommit { entries: FakeEntry[]; truncated?: boolean }
export interface FakeRepo { refs: Record<string, string>; commits: Record<string, FakeCommit> }
export interface FakeGithub { fetch: FetchLike; calls: string[]; repos: Record<string, FakeRepo> }

export const SHA_A = 'a'.repeat(40);
export const SHA_B = 'b'.repeat(40);

/** Every file under `directory`, mounted at `mountPath/` inside the fake repository. */
export function entriesFromDirectory(directory: string, mountPath: string): FakeEntry[] {
  const entries: FakeEntry[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      const path = `${mountPath === '' ? '' : `${mountPath}/`}${relative(directory, full).split('\\').join('/')}`;
      entries.push({ path, data: readFileSync(full) });
    }
  };
  walk(directory);
  return entries;
}

export function fakeGithub(repos: Record<string, FakeRepo>): FakeGithub {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const respond = (status: number, body: BodyInit | null = null, type = 'text/plain'): Response => new Response(body, { status, headers: { 'content-type': type } });
    if (u.host === 'api.github.com') {
      let m = /^\/repos\/([^/]+)\/([^/]+)\/commits\/(.+)$/.exec(u.pathname);
      if (m) {
        const repo = repos[`${m[1]}/${m[2]}`];
        const ref = decodeURIComponent(m[3]!);
        const sha = repo?.refs[ref] ?? (repo?.commits[ref] ? ref : undefined);
        return sha === undefined ? respond(404) : respond(200, sha);
      }
      m = /^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([0-9a-f]{40})$/.exec(u.pathname);
      if (m) {
        const commit = repos[`${m[1]}/${m[2]}`]?.commits[m[3]!];
        if (!commit) return respond(404);
        const dirs = new Set<string>();
        for (const e of commit.entries) { const parts = e.path.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
        const tree = [
          ...[...dirs].map(path => ({ path, mode: '040000', type: 'tree', sha: SHA_B })),
          ...commit.entries.map(e => ({ path: e.path, mode: e.mode ?? '100644', type: e.type ?? 'blob', sha: SHA_B, size: e.size ?? e.data?.length ?? 0 })),
        ];
        return respond(200, JSON.stringify({ sha: m[3], tree, truncated: commit.truncated ?? false }), 'application/json');
      }
      return respond(404);
    }
    if (u.host === 'raw.githubusercontent.com') {
      const m = /^\/([^/]+)\/([^/]+)\/([0-9a-f]{40})\/(.+)$/.exec(u.pathname);
      const entry = m && repos[`${m[1]}/${m[2]}`]?.commits[m[3]!]?.entries.find(e => e.path === decodeURIComponent(m[4]!));
      return entry?.data === undefined ? respond(404) : respond(200, new Uint8Array(entry.data), 'application/octet-stream');
    }
    return respond(404);
  };
  return { fetch, calls, repos };
}
