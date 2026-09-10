import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flow } from '@relayflows/surface';
import { afterEach, describe, expect, it } from 'vitest';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { JournalClient } from '../src/journal-client.js';

describe('named agent declarations', () => {
  const namedAgentDirectories: string[] = [];

  afterEach(() => {
    for (const directory of namedAgentDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function namedAgentFixture(models: string[]): { directory: string; flowPath: string } {
    const directory = mkdtempSync(join(tmpdir(), 'authored-named-agent-'));
    namedAgentDirectories.push(directory);
    writeFileSync(join(directory, 'flows.json'), JSON.stringify({ models }));
    return { directory, flowPath: join(directory, 'flow.ts') };
  }

  /**
   * A minimal custom-wrapper CLI that answers only the identification/auth
   * handshake (cli-adapter.ts) — enough for `declaration preflight` (the
   * upfront header check) and `checkAuthoredFlow`'s own probing to resolve
   * it as real and ready, without needing an execute-request handler:
   * every test using this stub expects to refuse before ever dispatching.
   */
  function authStubCli(directory: string, label: string): string {
    const cli = join(directory, `${label}-cli`);
    writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === 'auth' && process.argv[3] === 'status') process.exit(0);
if (process.argv[2] !== '--relayflows-adapter-v1') process.exit(9);
process.stdout.write('relayflows-agent-cli-v1\\n');
`);
    chmodSync(cli, 0o755);
    return cli;
  }

  it('rejects malformed declared models before probing or entering the body', async () => {
    const { directory, flowPath } = namedAgentFixture([]);
    rmSync(join(directory, 'flows.json')); // No allowlist refusal can mask an early probe.
    const marker = join(directory, 'effect.txt');
    const cli = join(directory, 'must-not-probe');
    writeFileSync(cli, `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'probe');
`);
    chmodSync(cli, 0o755);
    const handle = flow('invalid-declaration-model', {
      agents: { reviewer: { cli, model: 'invalid\u0000model' } },
    }, async f => {
      writeFileSync(marker, 'body');
      f.done('success');
    });
    await expect(executeAuthoredFlow(handle, new JournalClient('/journal-must-not-be-contacted'),
      undefined, { flowPath })).rejects.toMatchObject({
      code: 'agent_cli_unresolved', refusalKind: 'invalid_spec',
      message: expect.stringContaining('must not contain control characters'),
    });
    expect(existsSync(marker)).toBe(false);
  });

  it('resolves a named declaration\'s CLI, refusing before contacting the journal if it is missing', async () => {
    const { directory, flowPath } = namedAgentFixture(['known-model']);
    const disconnectedJournal = new JournalClient('/journal-must-not-be-contacted');
    const absentCli = join(directory, 'nonexistent-cli');

    await expect(executeAuthoredFlow(flow(
      'named-agent-cli-missing',
      { agents: { reviewer: { cli: absentCli, model: 'known-model' } } },
      async (f) => {
        await f.agent('reviewer', { task: 'review this' });
        f.done('success');
      },
    ), disconnectedJournal, undefined, { flowPath })).rejects.toMatchObject({
      code: 'agent_cli_unresolved',
      // The specific preflight refusal kind must survive the wrap into one
      // AuthoredFlowExecutionError code, or a caller (direct-run.ts's CLI
      // report) can't tell a missing CLI apart from a bad model.
      refusalKind: 'cli_missing',
      message: expect.stringContaining(
        `declares CLI "${absentCli}", but it does not resolve as an executable`,
      ),
    });
  });

  it('lets a step-level cli override win over the named declaration', async () => {
    const { directory, flowPath } = namedAgentFixture(['known-model']);
    const disconnectedJournal = new JournalClient('/journal-must-not-be-contacted');
    // The named declaration's own cli must resolve for real: the upfront
    // declaration preflight check now probes it before the body runs, so
    // an absent named cli would refuse there instead of exercising the
    // override this test is actually about.
    const namedCli = authStubCli(directory, 'named');
    const stepCli = join(directory, 'step-absent-cli');

    await expect(executeAuthoredFlow(flow(
      'named-agent-step-override',
      { agents: { reviewer: { cli: namedCli, model: 'known-model' } } },
      async (f) => {
        await f.agent('reviewer', { task: 'review this', cli: stepCli });
        f.done('success');
      },
    ), disconnectedJournal, undefined, { flowPath })).rejects.toMatchObject({
      code: 'agent_cli_unresolved',
      refusalKind: 'cli_missing',
      message: expect.stringContaining(`declares CLI "${stepCli}"`),
    });
  });

  it('does not treat an unrelated f.agent name as a named-agent selector', async () => {
    // "reviewer" is declared, but this step names "someone-else" — compile.ts's
    // resolveNamedAgent throws "unknown named agent" for any step.agent that
    // doesn't resolve, so if lowerAgent set `agent` unconditionally from
    // `name`, this would refuse with that error instead of falling through
    // to the (missing) flows.json project default like every undecorated
    // f.agent call does today.
    const { directory, flowPath } = namedAgentFixture(['known-model']);
    const disconnectedJournal = new JournalClient('/journal-must-not-be-contacted');
    // A real, resolvable stub — not the bare string "claude" — so the
    // upfront declaration preflight check (which now probes "reviewer"
    // for real regardless of whether the body selects it) passes
    // deterministically instead of depending on whatever CLIs happen to be
    // installed and authenticated on the machine running this test.
    const reviewerCli = authStubCli(directory, 'reviewer');

    await expect(executeAuthoredFlow(flow(
      'named-agent-name-not-selector',
      { agents: { reviewer: { cli: reviewerCli, model: 'known-model' } } },
      async (f) => {
        await f.agent('someone-else', { task: 'x' });
        f.done('success');
      },
    ), disconnectedJournal, undefined, { flowPath })).rejects.toMatchObject({
      code: 'agent_cli_unresolved',
      refusalKind: 'cli_unresolved',
      message: expect.not.stringContaining('unknown named agent'),
    });
  });

  it('refuses a named declaration whose model is not in the project registry', async () => {
    const { directory, flowPath } = namedAgentFixture(['some-other-model']);
    const disconnectedJournal = new JournalClient('/journal-must-not-be-contacted');

    await expect(executeAuthoredFlow(flow(
      'named-agent-model-unknown',
      { agents: { reviewer: { cli: join(directory, 'irrelevant-cli'), model: 'unlisted-model' } } },
      async (f) => {
        await f.agent('reviewer', { task: 'review this' });
        f.done('success');
      },
    ), disconnectedJournal, undefined, { flowPath })).rejects.toMatchObject({
      code: 'agent_cli_unresolved',
      refusalKind: 'model_unknown',
      message: expect.stringContaining(
        'Named agent "reviewer" declares model "unlisted-model"',
      ),
    });
  });

  it('refuses an unregistered model on a declared-but-never-selected named agent before the body runs', async () => {
    // A synchronous body effect detects entry even with a disconnected journal.
    const { directory, flowPath } = namedAgentFixture(['some-other-model']);
    const disconnectedJournal = new JournalClient('/journal-must-not-be-contacted');
    const marker = join(directory, 'marker.txt');

    await expect(executeAuthoredFlow(flow(
      'named-agent-unused-model-unknown',
      { agents: { unused: { cli: join(directory, 'irrelevant-cli'), model: 'unlisted-model' } } },
      async (f) => {
        writeFileSync(marker, 'body entered');
        f.done('success');
      },
    ), disconnectedJournal, undefined, { flowPath })).rejects.toMatchObject({
      code: 'agent_cli_unresolved',
      refusalKind: 'model_unknown',
      message: expect.stringContaining(
        'Named agent "unused" declares model "unlisted-model"',
      ),
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a declared agent's missing CLI before the body runs, even when the body does select it", async () => {
    // CLI readiness, like model policy, must refuse before body effects.
    const { directory, flowPath } = namedAgentFixture(['known-model']);
    const disconnectedJournal = new JournalClient('/journal-must-not-be-contacted');
    const marker = join(directory, 'marker.txt');
    const absentCli = join(directory, 'nonexistent-cli');

    await expect(executeAuthoredFlow(flow(
      'named-agent-late-cli-missing',
      { agents: { reviewer: { cli: absentCli, model: 'known-model' } } },
      async (f) => {
        writeFileSync(marker, 'body entered');
        await f.agent('reviewer', { task: 'review this' });
        f.done('success');
      },
    ), disconnectedJournal, undefined, { flowPath })).rejects.toMatchObject({
      code: 'agent_cli_unresolved',
      refusalKind: 'cli_missing',
      message: expect.stringContaining(`declares CLI "${absentCli}"`),
    });
    expect(existsSync(marker)).toBe(false);
  });
});
