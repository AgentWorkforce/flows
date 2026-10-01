import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { findHostedProject } from './hosted-project.js';
import { PluginError } from './plugin-manifest.js';

const REALPATH = realpath;
const PATH_BASENAME = basename;
const PATH_DIRNAME = dirname;
const PATH_IS_ABSOLUTE = isAbsolute;
const PATH_RELATIVE = relative;
const PATH_RESOLVE = resolve;
const PATH_SEPARATOR = sep;
const STRING_STARTS_WITH = Function.prototype.call.bind(String.prototype.startsWith) as (
  value: string,
  search: string,
) => boolean;

/**
 * Hosted source authority excludes the conventional `.relayflowd` tree. A
 * caller-selected journal inside any other part of the project would mutate
 * bytes covered by that authority after daemon admission, so refuse it before
 * a socket is opened. Existing symlink parents are canonicalized as well.
 */
export async function assertHostedDataDirectoryIsolated(
  flowPath: string,
  dataDir: string,
): Promise<void> {
  const origin = await REALPATH(PATH_RESOLVE(flowPath));
  const projectRoot = await REALPATH(findHostedProject(PATH_DIRNAME(origin)) ?? PATH_DIRNAME(origin));
  const target = await canonicalFuturePath(PATH_RESOLVE(dataDir));
  const relativePath = PATH_RELATIVE(projectRoot, target);
  const inside = relativePath === '' || (!PATH_IS_ABSOLUTE(relativePath)
    && relativePath !== '..' && !STRING_STARTS_WITH(relativePath, `..${PATH_SEPARATOR}`));
  if (!inside) return;
  if (relativePath === '.relayflowd'
    || STRING_STARTS_WITH(relativePath, `.relayflowd${PATH_SEPARATOR}`)) return;
  throw new PluginError(
    'plugin_source_invalid',
    'Hosted Software Garden data must use the project .relayflowd directory or a directory outside the project.',
  );
}

async function canonicalFuturePath(path: string): Promise<string> {
  const suffix: string[] = [];
  let cursor = path;
  for (;;) {
    try {
      const parent = await REALPATH(cursor);
      return PATH_RESOLVE(parent, ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const next = PATH_DIRNAME(cursor);
      if (next === cursor) throw error;
      suffix.unshift(PATH_BASENAME(cursor));
      cursor = next;
    }
  }
}
