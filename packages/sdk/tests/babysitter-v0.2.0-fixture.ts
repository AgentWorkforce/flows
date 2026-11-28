import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { entriesFromDirectory } from './fake-github.js';

const path = 'extensions/babysitter';
export const manifestBytes = readFileSync(resolve('../../testdata/plugins/babysitter-v0.2.0/flows-plugin.json'));

// These tests mock the exact GitHub tree at the pinned v0.2.0 commit. Only the
// manifest changed in v0.2.1. The full bundle digest still covers every file.
export const entries = entriesFromDirectory(resolve('../..', path), path).map(entry =>
  entry.path === path + '/flows-plugin.json' ? { ...entry, data: manifestBytes } : entry);
