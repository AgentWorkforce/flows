import { cpSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { basename, join } from 'node:path';

// Resume pins the whole Surface tree. A shared checkout can acquire temporary
// Bun build files while other tests compile the standalone CLI. Give this run
// its own package bytes without copying npm's dependency installation state.
export function copyPrivateSurface(source, destination) {
  const root = realpathSync(source);
  cpSync(root, destination, {
    recursive: true,
    filter: path => path !== join(root, 'node_modules')
      && !basename(path).endsWith('.bun-build'),
  });
  // Dependency state is excluded from Surface authority; retain resolution of
  // its installed peers without copying the dependency tree into the fixture.
  const dependencies = join(root, 'node_modules');
  if (existsSync(dependencies)) symlinkSync(dependencies, join(destination, 'node_modules'), 'dir');
}
