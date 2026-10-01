import {
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import {
  mkdtemp,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export interface PinnedCliAlias {
  executable: string;
  release(): void;
}

export interface PinnedCliAliasSync {
  executable: string;
  release(): void;
}

function aliasName(identity: string): string {
  const name = basename(identity);
  if (name.length === 0 || name === '.' || name === '..') {
    throw new Error(`Invalid CLI identity basename: ${JSON.stringify(identity)}`);
  }
  return name;
}

/** Execute pinned canonical bytes through the proved basename, including shebang scripts. */
export async function pinCliAlias(executable: string, identity: string): Promise<PinnedCliAlias> {
  const name = aliasName(identity);
  if (basename(executable) === name) {
    return { executable, release() {} };
  }
  const directory = await mkdtemp(join(tmpdir(), 'relayflow-cli-'));
  const alias = join(directory, name);
  try {
    await symlink(executable, alias, 'file');
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let released = false;
  return { executable: alias, release: () => {
    if (released) return;
    released = true;
    rmSync(directory, { recursive: true, force: true });
  } };
}

/** Synchronous counterpart for the synchronous preflight contract. */
export function pinCliAliasSync(executable: string, identity: string): PinnedCliAliasSync {
  const name = aliasName(identity);
  if (basename(executable) === name) {
    return { executable, release() {} };
  }
  const directory = mkdtempSync(join(tmpdir(), 'relayflow-cli-'));
  const alias = join(directory, name);
  try {
    symlinkSync(executable, alias, 'file');
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  let released = false;
  return { executable: alias, release: () => {
    if (released) return;
    released = true;
    rmSync(directory, { recursive: true, force: true });
  } };
}
