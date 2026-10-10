import { cpSync, existsSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
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

// A concurrent pack can publish helpers/index.js before helpers/postgres.js
// exports the binding it imports. Two identical reads reject a file replaced
// mid-check; the import/export pair rejects a snapshot taken across that gap.
export function surfaceDistConsistent(root) {
  const indexPath = join(root, 'dist', 'helpers', 'index.js');
  const postgresPath = join(root, 'dist', 'helpers', 'postgres.js');
  if (!existsSync(indexPath) || !existsSync(postgresPath)) return false;
  const index = readFileSync(indexPath, 'utf8');
  const postgres = readFileSync(postgresPath, 'utf8');
  if (readFileSync(indexPath, 'utf8') !== index || readFileSync(postgresPath, 'utf8') !== postgres) return false;
  if (!/\bexport\b/.test(index) || !/\bexport\b/.test(postgres)) return false;
  if (!index.includes('createPostgresHelper')) return true;
  return /export\s+(?:const|function|class)\s+createPostgresHelper\b/.test(postgres)
    || /export\s*\{[^}]*\bcreatePostgresHelper\b[^}]*\}/.test(postgres);
}
