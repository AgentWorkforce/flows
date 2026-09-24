import { mkdtempSync, rmSync } from 'node:fs';
import { afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A developer logged in with `agent-relay` has a real workspace key in
// ~/.agentworkforce/relay/workspaces.json, which `flows run` reads to project
// runs into Relaycast. No test may publish into that workspace: point the
// store at an empty directory and clear the env key, for this process and the
// CLI children that inherit its environment. Tests that exercise the observer
// stub their own key.
const isolatedHome = mkdtempSync(join(tmpdir(), 'flows-test-relay-home-'));
process.env['AGENT_RELAY_HOME'] = isolatedHome;
afterAll(() => rmSync(isolatedHome, { recursive: true, force: true }));
delete process.env['RELAYCAST_WORKSPACE_KEY'];
