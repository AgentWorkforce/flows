// Serve packed candidate packages locally; redirect other dependencies to npm.
// Usage: node stage-registry.mjs /absolute/artifact-directory [port] [bind-host; default 127.0.0.1]
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const directory = resolve(process.argv[2]);
const packages = new Map();
const tarballs = new Map();
for (const file of readdirSync(directory).filter(file => file.endsWith('.tgz'))) {
  const path = join(directory, file);
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', path, 'package/package.json'], { encoding: 'utf8' }));
  const data = readFileSync(path);
  packages.set(manifest.name, { manifest, file, integrity: `sha512-${createHash('sha512').update(data).digest('base64')}` });
  tarballs.set(`/tarballs/${file}`, data);
}
createServer((req, res) => {
  let url, name;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
    name = decodeURIComponent(url.pathname.slice(1));
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  const tarball = tarballs.get(url.pathname);
  if (tarball) { res.end(tarball); return; }
  const candidate = packages.get(name);
  if (!candidate) {
    res.writeHead(302, { location: `https://registry.npmjs.org${req.url}` });
    res.end();
    return;
  }
  const { manifest, file, integrity } = candidate;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ name, 'dist-tags': { latest: manifest.version }, versions: {
    [manifest.version]: { ...manifest, dist: { tarball: `${url.origin}/tarballs/${file}`, integrity } },
  } }));
}).listen(Number(process.argv[3] ?? 48731), process.argv[4] ?? '127.0.0.1', () => console.log('Candidate registry ready'));
