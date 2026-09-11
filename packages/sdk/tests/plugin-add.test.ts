import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, symlinkSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { addPlugin } from '../src/cli/add.js';
import { runCli } from '../src/cli.js';
const dirs: string[] = [];
const fixtureRoot = resolve('../../testdata/plugins');
afterEach(() => { dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); vi.unstubAllEnvs(); });
function project() {
  const cwd = mkdtempSync(join(tmpdir(), 'plugin-add-')); dirs.push(cwd);
  writeFileSync(join(cwd, 'flows.json'), '{}');
  writeFileSync(join(cwd, 'package.json'), '{"private":true}');
  const messages: string[] = [];
  const io = { stdout: (s: string) => messages.push(s), stderr: (s: string) => messages.push(s) };
  const install = (name: string, root: string) => cpSync(join(fixtureRoot, name.replace('@flows/', '')), join(root, 'node_modules', name), { recursive: true });
  return { cwd, io, install, messages };
}
it('installs a real offline npm fixture and includes declarations', async () => {
  vi.stubEnv('DATADOG_API_KEY', 'test'); const p = project();
  const install = (name: string, root: string) => {
    expect(name).toBe('@flows/helper-datadog');
    execFileSync('npm', ['install', '--save', '--ignore-scripts', '--offline', join(fixtureRoot, 'helper-datadog')], { cwd: root, stdio: 'pipe' });
  };
  expect(await addPlugin('helper-datadog', p.io, { cwd: p.cwd, install })).toBe(0);
  expect(JSON.parse(readFileSync(join(p.cwd, 'flows.json'), 'utf8')).plugins).toEqual(['@flows/helper-datadog']);
  expect(JSON.parse(readFileSync(join(p.cwd, 'tsconfig.json'), 'utf8')).include).toContain('node_modules/@flows/helper-datadog/flows-plugin.d.ts');
});
it.each([['helper-datadog', 'plugin_credential_missing'], ['helper-broken', 'plugin_manifest_missing'], ['helper-no-preflight', 'plugin_preflight_missing']])('refuses %s with %s', async (name, code) => {
  vi.stubEnv('DATADOG_API_KEY', ''); const p = project();
  expect(await addPlugin(name, p.io, p)).toBe(2);
  expect(p.messages.join('\n')).toContain(code);
  expect(JSON.parse(readFileSync(join(p.cwd, 'flows.json'), 'utf8'))).toEqual({});
});
it('classifies npm failures', async () => {
  for (const [stderr, code] of [['npm error code E404', 'plugin_unknown'], ['offline', 'plugin_install_failed']]) {
    const p = project();
    expect(await addPlugin('helper-nonexistent-npm-pkg', p.io, { cwd: p.cwd, install: () => { throw { stderr }; } })).toBe(2);
    expect(p.messages.join('\n')).toContain(code);
  }
});
it('wires add into CLI dispatch', async () => {
  const p = project(); expect(await runCli(['add', '../bad'], p.io)).toBe(2);
  expect(p.messages.join('\n')).toContain('plugin_manifest_invalid');
});

it('typechecks the augmented verb and rejects unknown namespaces', async () => {
  vi.stubEnv('DATADOG_API_KEY', 'test'); const p = project();
  expect(await addPlugin('helper-datadog', p.io, p)).toBe(0);
  mkdirSync(join(p.cwd, 'node_modules/@relayflows'), { recursive: true });
  symlinkSync(resolve('node_modules/@relayflows/surface'), join(p.cwd, 'node_modules/@relayflows/surface'));
  const config = JSON.parse(readFileSync(join(p.cwd, 'tsconfig.json'), 'utf8'));
  config.compilerOptions = { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: true, noEmit: true };
  writeFileSync(join(p.cwd, 'tsconfig.json'), JSON.stringify(config));
  const source = "import { flow } from '@relayflows/surface'; export default flow('x', async f => { await f.datadog.query({metric:'test'}); f.done('success'); });";
  writeFileSync(join(p.cwd, 'flow.ts'), source);
  const tsc = resolve('node_modules/typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', join(p.cwd, 'tsconfig.json')], { stdio: 'pipe' });
  writeFileSync(join(p.cwd, 'flow.ts'), source.replace('f.datadog.query', 'f.notarealplugin.foo'));
  expect(() => execFileSync(process.execPath, [tsc, '-p', join(p.cwd, 'tsconfig.json')], { stdio: 'pipe' })).toThrow();
});
