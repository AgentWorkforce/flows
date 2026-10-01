import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const RELAY_PEERS = ['@agent-relay/harness-driver', '@agent-relay/sdk'] as const;
const RANGE = '>=12.3.1 <14';

describe('Agent Relay peer compatibility', () => {
  it('accepts Relay 12 and 13 consistently in the package and lock metadata', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const packageLock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
    const lockedRoot = packageLock.packages[''];

    for (const dependency of RELAY_PEERS) {
      expect(packageJson.peerDependencies[dependency]).toBe(RANGE);
      expect(packageJson.peerDependenciesMeta[dependency]).toEqual({ optional: true });
      expect(lockedRoot.peerDependencies[dependency]).toBe(RANGE);
      expect(lockedRoot.peerDependenciesMeta[dependency]).toEqual({ optional: true });
    }
  });
});
