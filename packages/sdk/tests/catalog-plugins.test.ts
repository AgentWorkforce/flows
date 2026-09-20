import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SHA = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TIERS = new Set(['first-party', 'verified', 'community']);

describe('catalog/plugins.json', () => {
  const catalog = JSON.parse(readFileSync(resolve('../../catalog/plugins.json'), 'utf8')) as {
    version: unknown;
    plugins: Array<Record<string, unknown>>;
  };

  it('is version 1 with unique kebab-case plugin names', () => {
    expect(catalog.version).toBe(1);
    expect(Array.isArray(catalog.plugins)).toBe(true);
    expect(catalog.plugins.length).toBeGreaterThan(0);
    const names = catalog.plugins.map(p => p.name);
    expect(names.every(n => typeof n === 'string' && NAME.test(n))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it('records a fail-closed babysitter entry with a pinned sha and digest', () => {
    const babysitter = catalog.plugins.find(p => p.name === 'babysitter');
    expect(babysitter).toMatchObject({
      source: { owner: 'AgentWorkforce', repo: 'flows', path: 'examples/babysitter' },
      tier: 'community',
      base: ['software-factory'],
    });
    expect(babysitter!.ref).toMatch(SHA);
    expect(babysitter!.digest).toMatch(HEX64);
    expect(String(babysitter!.description)).toContain('plugin_event_unroutable');
    expect(TIERS.has(String(babysitter!.tier))).toBe(true);
  });
});
