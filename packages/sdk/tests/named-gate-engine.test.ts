import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { buildSync } from 'esbuild';
import { expect, it } from 'vitest';
import { RE2JS_DEFLATED_BASE64, RE2JS_VERSION } from '../src/re2js-embedded.js';

const sdk = fileURLToPath(new URL('../', import.meta.url));
const generator = fileURLToPath(new URL('../../../scripts/generate-re2js-embed.mjs', import.meta.url));

it('pins the embedded engine to the installed CJS source and version', () => {
  const check = spawnSync(process.execPath, [generator, '--check'], { encoding: 'utf8' });
  expect(check.status, check.stderr + check.stdout).toBe(0);
  const engine = createRequire(join(sdk, 'package.json')).resolve('re2js');
  let directory = dirname(engine);
  for (;;) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (pkg.name === 're2js') { expect(RE2JS_VERSION).toBe(pkg.version); break; }
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Cannot find re2js manifest');
    directory = parent;
  }
  const raw = inflateRawSync(Buffer.from(RE2JS_DEFLATED_BASE64, 'base64'));
  expect(raw.equals(readFileSync(engine))).toBe(true);
  const exports = {} as { RE2JS: { compile(pattern: string): { matcher(text: string): { find(): boolean } } } };
  new Function('exports', raw.toString())(exports);
  expect(exports.RE2JS.compile('^ok$').matcher('ok').find()).toBe(true);
  expect(exports.RE2JS.compile('^ok$').matcher('nope').find()).toBe(false);
});

it('lowers and executes a bundled regex gate without package resolution', () => {
  const directory = mkdtempSync(join(tmpdir(), 'named-gate-engine-'));
  try {
    // Refuse an accidentally dependency-bearing fixture; NODE_PATH is cleared below.
    for (let parent = directory;; parent = dirname(parent)) {
      expect(existsSync(join(parent, 'node_modules/re2js'))).toBe(false);
      if (dirname(parent) === parent) break;
    }
    const entry = join(directory, 'entry.ts');
    const bundle = join(directory, 'bundle.mjs');
    writeFileSync(entry, `import { lowerNamedGates } from ${JSON.stringify(join(sdk, 'src/named-gate-lowering.ts'))};
console.log(lowerNamedGates([{ id: 'produce', type: 'deterministic', command: 'printf ok',
  verification: { type: 'regex_match', pattern: '^ok$' } }])[1].command);`);
    buildSync({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'esm' });
    const env = { ...process.env, NODE_PATH: '' };
    const lowered = spawnSync(process.execPath, [bundle], { cwd: directory, env, encoding: 'utf8' });
    expect(lowered.status, lowered.stderr).toBe(0);
    const command = lowered.stdout.trim();
    expect(command).toMatch(/^node -e /);
    expect(command).not.toContain('re2js');
    // Anchors ensure the negative input cannot pass an unanchored substring search.
    for (const [text, status] of [['ok', 0], ['nope', 1]] as const) {
      const result = spawnSync('/bin/sh', ['-c', command], {
        cwd: directory, encoding: 'utf8',
        env: { ...env, FLOWS_INPUT: JSON.stringify({ output: { exit_code: 0, stdout_tail: text, stderr_tail: '' } }) },
      });
      expect(result.status, result.stderr).toBe(status);
      expect(result.stderr).toBe('');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
