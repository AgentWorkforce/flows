import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolSchema, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { FlowToolClient, type FlowToolTransport } from '../src/flow-tool-client.js';
import { createFlowToolAdapters } from '../src/flow-tool-adapters.js';
import { parseFlowToolCatalog, canonicalFlowToolCatalog, parseFlowToolInvocation, parseFlowToolRun, parseFlowToolEvent } from '../src/flow-tool-wire.js';
import { createFlowToolManifest } from '../src/flow-tool-manifest.js';
import { FixtureControlPlane, entry, copy } from './flow-tool-control-fixture.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'flow-tool-contract-'));
  directories.push(directory);
  const backend = new FixtureControlPlane(join(directory, 'fixture.json'));
  return { backend, client: new FlowToolClient(backend) };
}
const invoke = (client: FlowToolClient, key = 'operation-1') => client.invoke(entry, { pr: 42 }, { idempotencyKey: key });

describe('canonical Flow Tool lifecycle (persisted fixture, not hosted execution)', () => {
  it('discovers a pinned read-only revision, admits asynchronously, and validates a hold result/evidence', async () => {
    const { client, backend } = fixture();
    expect((await client.discover()).tools).toEqual([entry]);
    const receipt = await invoke(client);
    expect(receipt.state).toBe('accepted'); expect(receipt.terminal).toBeNull();
    backend.complete(receipt.run_id);
    const result = await client.status(entry, receipt);
    expect(result.terminal?.terminal_reason).toBe('success');
    expect(result.terminal?.business_verdict).toBe('hold');
    expect(result.terminal?.gates[0]?.status).toBe('fail');
    expect(await client.evidence(entry, result)).toEqual(result.terminal?.evidence);
  });

  it('preserves one admission across concurrent fixture requests, lost response and reconstruction', async () => {
    const { client, backend } = fixture();
    backend.loseNextAdmissionResponse = true;
    await expect(invoke(client)).rejects.toMatchObject({ code: 'transport_error' });
    const reconstructed = new FlowToolClient(new FixtureControlPlane(backend.path));
    const receipts = await Promise.all(Array.from({ length: 8 }, () => invoke(reconstructed)));
    expect(new Set(receipts.map(receipt => receipt.run_id)).size).toBe(1);
    expect(backend.count).toBe(1);
    await expect(reconstructed.invoke(entry, { pr: 43 }, { idempotencyKey: 'operation-1' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(backend.count).toBe(1);
  });

  it('uses persisted completion after reconstruction and never resumes a new invocation', async () => {
    const { client, backend } = fixture();
    const receipt = await invoke(client); backend.complete(receipt.run_id);
    const restored = new FlowToolClient(new FixtureControlPlane(backend.path));
    const terminal = await restored.status(entry, receipt);
    expect(await restored.resume(entry, terminal, 'resume-1')).toEqual(terminal);
    expect(await invoke(restored)).toEqual(terminal);
    expect(backend.count).toBe(1);
  });

  it('replays strictly after a persisted cursor and reports the same digest', async () => {
    const { client, backend } = fixture();
    const receipt = await invoke(client);
    const first = []; for await (const event of client.events(entry, receipt)) first.push(event);
    expect(first.map(event => event.sequence)).toEqual([1]);
    backend.complete(receipt.run_id);
    const restored = new FlowToolClient(new FixtureControlPlane(backend.path));
    const next = []; for await (const event of restored.events(entry, receipt, 1)) next.push(event);
    expect(next.map(event => event.sequence)).toEqual([2]);
    expect(next[0]?.flow_digest).toBe(entry.manifest.flow.digest);
  });

  it('scopes fixture idempotency by principal and refuses cross-principal status/evidence/events', async () => {
    const { client, backend } = fixture(), receipt = await invoke(client);
    const other = new FlowToolClient(new FixtureControlPlane(backend.path, 'tenant-2/principal-2'));
    expect((await invoke(other)).run_id).not.toBe(receipt.run_id);
    await expect(other.status(entry, receipt)).rejects.toMatchObject({ code: 'not_authorized' });
    await expect(other.evidence(entry, receipt)).rejects.toMatchObject({ code: 'not_authorized' });
    await expect(other.events(entry, receipt)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'not_authorized' });
    const denied = new FlowToolClient(new FixtureControlPlane(backend.path, 'tenant-1/principal-1', false));
    expect((await denied.discover()).tools).toEqual([]);
    await expect(invoke(denied)).rejects.toMatchObject({ code: 'not_authorized' });
  });

  it('keeps cancel idempotent and derives human identity outside the payload', async () => {
    const { client, backend } = fixture(), receipt = await invoke(client);
    await client.answer(entry, receipt, 'wait-1', false, 'answer-1');
    expect(backend.calls.at(-1)?.body).toEqual({ api_version: 1, input: { approved: false } });
    const cancelled = await client.cancel(entry, receipt, 'cancel-1');
    expect(cancelled.terminal?.terminal_reason).toBe('canceled');
    expect(await client.cancel(entry, cancelled, 'cancel-1')).toEqual(cancelled);
    expect(await client.resume(entry, cancelled, 'resume-1')).toEqual(cancelled);
    await expect(client.answer(entry, cancelled, 'wait-1', true, 'answer-1')).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(backend.count).toBe(1);
  });

  it('native, MCP and action adapters produce the identical canonical receipt with one operation key', async () => {
    const { client, backend } = fixture(), adapters = createFlowToolAdapters(client, entry);
    const operation = { idempotencyKey: 'adapter-operation' };
    const native = await adapters.native.call({ pr: 42 }, operation);
    const mcp = await adapters.mcp.call({ pr: 42 }, operation);
    const action = await adapters.action.invoke({ pr: 42 }, operation);
    expect(native).toEqual(mcp.structuredContent); expect(native).toEqual(action);
    expect(JSON.parse(mcp.content[0]!.text)).toEqual(native);
    expect(ToolSchema.parse(adapters.mcp.definition)).toEqual(adapters.mcp.definition);
    expect(CallToolResultSchema.parse(mcp)).toEqual(mcp);
    expect(adapters.mcp.definition.outputSchema).not.toEqual(entry.manifest.resultSchema);
    expect(backend.count).toBe(1);
  });

  it.each([{}, null, { pr: '42' }, { pr: 42, tenant: 'escape' }, { pr: 42, budget: 999 }, { pr: 42, text: 'x'.repeat(262145) }])('rejects invalid input before transport %#', async input => {
    const { client, backend } = fixture();
    await expect(client.invoke(entry, input, { idempotencyKey: 'operation' })).rejects.toThrow();
    expect(backend.calls).toHaveLength(0); expect(backend.count).toBe(0);
  });

  it.each([{ mode: 'async', waitMs: 1 }, { mode: 'sync', waitMs: 25001 }, { mode: 'sync', waitMs: -1 }, { mode: 'other' }])('refuses invalid observation options %#', async options => {
    const { client, backend } = fixture();
    await expect(client.invoke(entry, { pr: 42 }, { idempotencyKey: 'op', ...options } as never)).rejects.toThrow();
    expect(backend.calls).toHaveLength(0);
  });

  it('bounded sync uses the same admission path and may return an unfinished receipt', async () => {
    const { client, backend } = fixture();
    const run = await client.invoke(entry, { pr: 42 }, { idempotencyKey: 'op', mode: 'sync', waitMs: 25000 });
    expect(run.terminal).toBeNull();
    expect(backend.calls[0]?.body).toMatchObject({ mode: 'sync', wait_ms: 25000 });
  });
});

describe('fail-closed public projections', () => {
  it('validates the shared Cloud/SDK golden wire fixture without recomputing its stored hashes', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/flow-tool-api-v1.json', import.meta.url), 'utf8'));
    expect(fixture.fixture_only).toBe(true);
    const selected = parseFlowToolCatalog(fixture.catalog).tools[0]!;
    parseFlowToolInvocation(fixture.invoke, selected);
    const receipt = parseFlowToolRun(fixture.receipt, selected);
    expect(parseFlowToolRun(fixture.terminal, selected, receipt).terminal?.business_verdict).toBe('hold');
    let cursor = 0;
    for (const event of fixture.events) cursor = parseFlowToolEvent(event, receipt, cursor).sequence;
    expect(cursor).toBe(2);
  });
  it('canonicalizes discovery independently of catalog order', () => {
    const second = { ...entry, manifest: createFlowToolManifest({
      name: 'another_tool', description: entry.manifest.description, flow: entry.manifest.flow,
      inputSchema: entry.manifest.inputSchema, resultSchema: entry.manifest.resultSchema,
    }) };
    expect(canonicalFlowToolCatalog({ api_version: 1, tools: [entry, second] }))
      .toBe(canonicalFlowToolCatalog({ tools: [second, entry], api_version: 1 }));
  });

  it('rejects admission receipt bound to a different canonical input', async () => {
    const { client } = fixture(), receipt = await invoke(client);
    const transport: FlowToolTransport = {
      request: async () => ({ ...receipt, input_digest: `sha256:${'c'.repeat(64)}` }),
      async *events() { /* not used */ },
    };
    await expect(invoke(new FlowToolClient(transport))).rejects.toMatchObject({ code: 'invalid_contract' });
  });

  it('does not echo sensitive property names from snapshot failures at the client boundary', async () => {
    const { client } = fixture(), receipt = await invoke(client);
    const invalid = client.invoke(entry, { 'secret-key-fixture': NaN }, { idempotencyKey: 'op' });
    await expect(invalid).rejects.toMatchObject({ code: 'invalid_contract' });
    try { await invalid; }
    catch (error) { expect(String(error)).not.toContain('secret-key-fixture'); expect(error).toMatchObject({ code: 'invalid_contract' }); }
    const transport: FlowToolTransport = {
      request: async () => ({ 'secret-key-fixture': Infinity }), async *events() {},
    };
    await expect(new FlowToolClient(transport).evidence(entry, receipt)).rejects.toMatchObject({ code: 'invalid_contract' });
    try { await new FlowToolClient(transport).evidence(entry, receipt); }
    catch (error) { expect(String(error)).not.toContain('secret-key-fixture'); }
  });

  it.each(['gate_failed', 'model_failed', 'agent_failed', 'budget_exceeded', 'human_rejected', 'human_timeout', 'execution_failed'])('preserves distinct failed terminal reason %s', async reason => {
    const { client, backend } = fixture(), receipt = await invoke(client); backend.complete(receipt.run_id);
    const raw = copy(await client.status(entry, receipt)) as any;
    raw.state = 'failed'; raw.terminal.terminal_reason = reason;
    raw.terminal.business_verdict = null; raw.terminal.result = null;
    expect(parseFlowToolRun(raw, entry, receipt).terminal?.terminal_reason).toBe(reason);
  });
  it.each([
    (value: any) => { value.tools[0].read_only = false; },
    (value: any) => { value.tools[0].effects = ['github:write']; },
    (value: any) => { value.tools.push(copy(value.tools[0])); },
    (value: any) => { value.tools[0].manifest.description = 'input-injected description'; },
    (value: any) => { value.tools[0].budget.max_dollars = '-1'; },
    (value: any) => { value.tools[0].credentials = 'secret-fixture'; },
    (value: any) => { value.api_version = 2; },
  ])('refuses malformed/escalated discovery %# without echoing data', change => {
    const value = copy({ api_version: 1, tools: [entry] }); change(value);
    expect(() => parseFlowToolCatalog(value)).toThrow('invalid_contract');
    try { parseFlowToolCatalog(value); } catch (error) { expect(String(error)).not.toContain('secret-fixture'); }
  });

  it.each([
    (value: any) => { value.terminal = null; },
    (value: any) => { value.state = 'running'; },
    (value: any) => { value.flow_digest = `sha256:${'c'.repeat(64)}`; },
    (value: any) => { value.manifest_digest = `sha256:${'c'.repeat(64)}`; },
    (value: any) => { value.status_url = 'https://attacker.invalid/run'; },
    (value: any) => { value.terminal.result.findings = 'one'; },
    (value: any) => { value.terminal.business_verdict = 'merge'; },
    (value: any) => { value.terminal.terminal_reason = 'model_sentence_success'; },
    (value: any) => { value.terminal.spend.dollars_unmetered = true; },
    (value: any) => { value.terminal.spend.tokens_in = -1; },
    (value: any) => { value.terminal.gates[0].evidence_ref = 'missing'; },
    (value: any) => { value.terminal.evidence.artifacts[0].ref = 'https://attacker.invalid/secret'; },
    (value: any) => { value.terminal.evidence.environment = { TOKEN: 'secret-fixture' }; },
    (value: any) => { value.terminal.evidence.journal_digest = 'mutable'; },
    (value: any) => { value.sequence = 0; },
  ])('refuses contradictory, unbound or unsafe terminal data %#', async change => {
    const { client, backend } = fixture(), receipt = await invoke(client); backend.complete(receipt.run_id);
    const raw = copy(await client.status(entry, receipt)); change(raw);
    expect(() => parseFlowToolRun(raw, entry, receipt)).toThrow('invalid_contract');
  });

  it.each(['flow', 'deployment_id', 'manifest_digest', 'input_digest', 'tenant_id'])('refuses forged admission binding %s', async field => {
    const { client, backend } = fixture(); await invoke(client);
    const body = copy(backend.calls[0]!.body) as any; body[field] = 'forged';
    expect(() => parseFlowToolInvocation(body, entry)).toThrow('invalid_contract');
  });

  it('rejects changed terminal receipts, replayed event IDs and raw protected event payloads', async () => {
    const { client, backend } = fixture(), receipt = await invoke(client); backend.complete(receipt.run_id);
    const terminal = await client.status(entry, receipt), changed = copy(terminal) as any;
    changed.terminal.result.findings = 2; changed.sequence++;
    expect(() => parseFlowToolRun(changed, entry, terminal)).toThrow('invalid_contract');
    const event = { api_version: 1, run_id: receipt.run_id, flow_digest: receipt.flow_digest, sequence: 1, state: 'accepted', type: 'run.accepted' };
    expect(() => parseFlowToolEvent(event, receipt, 1)).toThrow('invalid_contract');
    expect(() => parseFlowToolEvent({ ...event, prompt: 'secret-fixture' }, receipt, 0)).toThrow('invalid_contract');
    const bad: FlowToolTransport = { request: async () => receipt, async *events() { yield event; yield event; } };
    const iterator = new FlowToolClient(bad).events(entry, receipt)[Symbol.asyncIterator]();
    await iterator.next(); await expect(iterator.next()).rejects.toThrow('invalid_contract');
  });
});
