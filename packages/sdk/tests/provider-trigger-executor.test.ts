import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { github, slack } from '@relayflows/surface';
import { compileSpec, toKernelSpec } from '../src/compile.js';
import { providerInboxEvent, webhookTriggerSpec } from '../src/trigger-executor.js';

const binary = process.env['RELAYFLOWD_BIN'] ?? resolve('../../kernel/target/debug/relayflowd');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('validates and snapshots provider envelopes before they reach an inbox', () => {
  const input = { type: 'pull_request', payload: { action: 'opened' } };
  const event = providerInboxEvent('github', input);
  input.payload.action = 'closed';
  expect(event).toEqual({ provider: 'github', type: 'pull_request', payload: { action: 'opened' } });
  expect(Object.isFrozen(event.payload)).toBe(true);
  expect(() => providerInboxEvent('unknown', input)).toThrow(/unknown provider/);
  expect(() => providerInboxEvent('toString', input)).toThrow(/unknown provider/);
  expect(() => providerInboxEvent('slack', input)).toThrow(/unknown event type/);
  expect(() => providerInboxEvent('github', { ...input, provider: 'slack' })).toThrow(/does not match/);
  for (const payload of [undefined, null, 1, [], { invalid: Infinity }]) {
    expect(() => providerInboxEvent('github', { type: 'pull_request', payload })).toThrow();
  }
});

it.each([
  { source: slack.mention('C123'), type: 'app_mention', payload: { channel: 'C123' }, rejected: { channel: 'C456' } },
  { source: slack.reaction('eyes'), type: 'reaction_added', payload: { reaction: 'eyes' }, rejected: { reaction: 'heart' } },
  { source: github.pull_request('opened'), type: 'pull_request', payload: { action: 'opened' }, rejected: { action: 'closed' } },
])('the kernel executes compiled $type subscriptions with provider isolation and durable dedupe', ({ source, type, payload, rejected }) => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-executor-'));
  dirs.push(dir);
  const effect = join(dir, 'effect.txt');
  const spec = join(dir, 'binding.json');
  writeFileSync(spec, JSON.stringify(toKernelSpec(compileSpec({
    version: '0.1.0', name: 'provider-test',
    triggers: [webhookTriggerSpec('event', source)],
    steps: [{ id: 'effect', type: 'deterministic', command: `printf accepted >> '${effect}'` }],
  }))));
  const submit = (envelope: unknown, key: string, executor = source.name) => JSON.parse(execFileSync(binary, [
    '--data-dir', dir, 'run', spec, '--event', JSON.stringify({ type: executor, payload: envelope, key }),
  ], { encoding: 'utf8', stdio: 'pipe' })) as { matched: boolean; deduped: boolean; run: { run_id: string } | null };
  const event = providerInboxEvent(source.name, { type, payload });
  for (const envelope of [
    { ...event, provider: 'other' }, { ...event, type: 'other' }, { ...event, payload: rejected },
  ]) {
    expect(submit(envelope, 'rejected')).toMatchObject({ matched: false, run: null });
  }
  expect(submit(event, 'wrong-inbox', 'other')).toMatchObject({ matched: false, run: null });
  const first = submit(event, 'event-1.json');
  expect(first).toMatchObject({ matched: true, deduped: false });
  expect(readFileSync(effect, 'utf8')).toBe('accepted');
  expect(submit(event, 'event-1.json')).toMatchObject({ matched: true, deduped: true, run: null });
  expect(readFileSync(effect, 'utf8')).toBe('accepted');
  expect(submit(event, 'event-2.json')).toMatchObject({ matched: true, deduped: false });
  expect(readFileSync(effect, 'utf8')).toBe('acceptedaccepted');
});
