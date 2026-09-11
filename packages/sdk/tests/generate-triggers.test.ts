import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const generator = fileURLToPath(new URL('../../../scripts/generate-triggers.mjs', import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'provider-codegen-'));
  dirs.push(dir);
  return dir;
}
function generate(...args: string[]): string {
  return execFileSync(process.execPath, [generator, ...args], { encoding: 'utf8', stdio: 'pipe' });
}
function mapping(root: string, path: string, value: unknown): void {
  const target = join(root, 'packages', path);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'test.mapping.yaml'), JSON.stringify(value));
}

it('reproduces all checked-in modules from the pinned adapter mappings', () => {
  expect(generate('--check')).toContain('Checked 2 provider trigger modules');
});

it('discovers new adapters, preserves exact event names, and prefers adapter-local mappings', () => {
  const root = temporary();
  const out = join(root, 'generated');
  mapping(root, 'core/mappings', { adapter: { name: 'github' }, webhooks: { stale: {} } });
  mapping(root, 'github', { adapter: { name: 'github' }, webhooks: { pull_request: { extract: ['action'] } } });
  mapping(root, 'new-provider', { provider: 'new-provider', webhooks: { 'file.created': {}, 'file.deleted': {} } });
  mapping(root, 'no-events', { provider: 'no-events', webhooks: {} });
  generate('--adapters-dir', root, '--out-dir', out);
  expect(readdirSync(out).sort()).toEqual(['github.ts', 'index.ts', 'new-provider.ts']);
  expect(readFileSync(join(out, 'github.ts'), 'utf8')).toContain('pull_request(action?: string)');
  expect(readFileSync(join(out, 'github.ts'), 'utf8')).not.toContain('stale');
  const provider = readFileSync(join(out, 'new-provider.ts'), 'utf8');
  expect(provider).toContain('export const new_provider');
  expect(provider).toContain('file_created(filter?: WebhookFilter)');
  expect(provider).toContain('providerTrigger("new-provider", "file.created", filter)');
  generate('--adapters-dir', root, '--out-dir', out, '--check');
  mapping(root, 'no-events', { provider: 'no-events', webhooks: { added: {} } });
  generate('--adapters-dir', root, '--out-dir', out);
  expect(readdirSync(out)).toContain('no-events.ts');
  mapping(root, 'no-events', { provider: 'no-events', webhooks: {} });
  generate('--adapters-dir', root, '--out-dir', out);
  expect(readdirSync(out)).not.toContain('no-events.ts');
  writeFileSync(join(out, 'new-provider.ts'), 'stale');
  expect(() => generate('--adapters-dir', root, '--out-dir', out, '--check')).toThrow(/drifted/);
});

it('fails closed on malformed mappings and colliding method names before writing output', () => {
  for (const webhooks of [[], { broken: null }, { 'file.created': {}, file_created: {} }]) {
    const root = temporary();
    mapping(root, 'example', { provider: 'example', webhooks });
    expect(() => generate('--adapters-dir', root, '--out-dir', join(root, 'out'))).toThrow();
    expect(readdirSync(root)).toEqual(['packages']);
  }
});
