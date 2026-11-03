import { afterEach, describe, expect, it, vi } from 'vitest';
import { askJev } from '../src/jev-client.js';
import { localAgentCredentialEnvironment, validatedLocalAgentEnvironment } from '../src/local-agent-environment.js';
import { preflight } from '../src/preflight.js';
import { validatePluginManifest } from '../src/plugin-manifest.js';
import { classifyOptions, classifyPrompt, isClassifyStep, readClassifyResult } from '../src/classify-contract.js';

const options = { question: 'Review depth?', state: 'a diff', options: { small: 'tiny', deep: 'sensitive' } };
const environment = { TYPESAFE_API_KEY: 'private-test-key' };
const answer = (choice: unknown = 'small', confidence: unknown = 0.9, type = 'choice') =>
  new Response(JSON.stringify({ answers: { classification: { type, choice, confidence } } }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('TypeSafe Jev contract', () => {
  it('reserves the classifier namespace against helper plugins', () => {
    expect(() => validatePluginManifest({ name: 'helper-collision', version: '1.0.0',
      verbs: [{ namespace: 'classify', method: 'replace', lowersTo: 'effect', args: {} }],
      triggers: [], gates: [], preflight: { credentials: [], servers: [] },
    })).toThrow('Invalid or reserved plugin verb.');
  });
  it('honors model policy and reports unmetered spend without a CLI probe', () => {
    const probe = vi.fn(() => { throw new Error('must not probe a CLI'); });
    const spec = { version: '0.1.0' as const, name: 'classify-policy', steps: [{
      id: 'depth', type: 'llm' as const, model: 'jev-latest', prompt: classifyPrompt(options),
    }] };
    const common = { modelRegistryPath: '/project/flows.json', projectCli: 'must-not-run',
      probes: { cli: probe, command: probe, executor: probe } };
    const denied = preflight(spec, { ...common, models: ['other-model'] });
    expect(denied.ok).toBe(false);
    expect(denied.diagnostics).toContainEqual(expect.objectContaining({ kind: 'model_unknown', model: 'jev-latest' }));
    const allowed = preflight(spec, { ...common, models: ['jev-latest'] });
    expect(allowed.ok).toBe(true);
    expect(allowed.resolutions).toEqual([]);
    expect(allowed.diagnostics).toContainEqual(expect.objectContaining({ kind: 'budget_unmetered' }));
    expect(probe).not.toHaveBeenCalled();
  });
  it('honors an explicit flow CLI and shares native dispatch recognition', () => {
    const step = { id: 'depth', type: 'llm' as const, model: 'jev-latest', prompt: classifyPrompt(options) };
    expect(isClassifyStep(step)).toBe(true);
    expect(isClassifyStep({ ...step, prompt: 'ordinary prompt' })).toBe(false);
    expect(isClassifyStep(step, 'declared-cli')).toBe(false);
    const cli = vi.fn(() => ({ exists: true, authenticated: true as const, supported: true, modelAvailable: true }));
    const result = preflight({ version: '0.1.0', name: 'explicit-cli', cli: 'declared-cli', steps: [step] }, {
      models: ['jev-latest'], modelRegistryPath: '/project/flows.json',
      probes: { cli, command: () => true, executor: () => false },
    });
    expect(result.resolutions).toEqual([expect.objectContaining({ cli: 'declared-cli', stepId: 'depth' })]);
    expect(cli).toHaveBeenCalledOnce();
  });
  it('refuses malformed or foreign journal answers before typed branching', () => {
    const valid = { choice: 'small', confidence: 0.9, completionReason: 'success' };
    expect(readClassifyResult(valid, options)).toEqual(valid);
    for (const patch of [{ choice: 'unknown' }, { confidence: 2 }, { confidence: 0.1 },
      { completionReason: 'worker_error' }, { fallbackReason: 'jev_timeout' }]) {
      expect(readClassifyResult({ ...valid, ...patch }, options)).toBeUndefined();
    }
    expect(readClassifyResult(null, options)).toBeUndefined();
    expect(readClassifyResult({ choice: 'deep', confidence: 0, completionReason: 'success', fallbackReason: 'jev_timeout' },
      { ...options, fallback: 'deep' })).toMatchObject({ choice: 'deep', fallbackReason: 'jev_timeout' });
  });
  it('preserves the provider-only credential overlay through the authored worker handoff', () => {
    const overlay = localAgentCredentialEnvironment({ ...environment, PATH: '/must-not-cross' });
    expect(overlay).toEqual(environment);
    expect(validatedLocalAgentEnvironment(overlay)).toEqual(environment);
  });
  it('posts the choice question with an environment credential and fixed endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(answer());
    vi.stubGlobal('fetch', fetch);
    expect(await askJev(options, environment)).toEqual({ choice: 'small', confidence: 0.9, completionReason: 'success' });
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(request).toMatchObject({ method: 'POST', redirect: 'manual', headers: { Authorization: 'Bearer private-test-key' } });
    expect(JSON.parse(request.body)).toEqual({ model: 'jev-latest', state: 'a diff', questions: {
      classification: { type: 'choice', instructions: 'Review depth?', criteria: options.options },
    } });
    expect(classifyPrompt(options)).not.toContain(environment.TYPESAFE_API_KEY);
  });
  it('fails closed without a key, or records an explicitly declared fallback', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(askJev(options, {})).rejects.toMatchObject({ diagnostic: 'typesafe_api_key_missing', completionReason: 'worker_error' });
    expect(await askJev({ ...options, fallback: 'deep' }, {})).toEqual({
      choice: 'deep', confidence: 0, completionReason: 'success', fallbackReason: 'typesafe_api_key_missing',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    [answer('unknown'), 'jev_invalid_answer'], [answer('toString'), 'jev_invalid_answer'],
    [answer('small', -1), 'jev_invalid_answer'], [answer('small', 1.01), 'jev_invalid_answer'],
    [answer('small', '0.9'), 'jev_invalid_answer'], [answer('small', 0.9, 'text'), 'jev_invalid_answer'],
    [new Response('null'), 'jev_invalid_answer'], [new Response('{'), 'jev_invalid_json'],
    [answer('deep', 0.59), 'jev_low_confidence'],
  ])('rejects malformed or uncertain responses %#', async (response, diagnostic) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(askJev(options, environment)).rejects.toMatchObject({ diagnostic, completionReason: 'verification_failed' });
  });
  it('accepts confidence at the threshold and prototype-like declared choices', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer('toString', 0.6)));
    expect(await askJev({ ...options, options: { toString: 'yes', deep: 'no' } }, environment))
      .toMatchObject({ choice: 'toString', confidence: 0.6 });
  });
  it.each([401, 429, 500, 302])('bounds HTTP %s diagnostics and never echoes the body', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private-test-key', { status })));
    await expect(askJev(options, environment)).rejects.toMatchObject({ message: `f.classify: jev_http_${status}` });
  });
  it('sanitizes network exceptions, including credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(environment.TYPESAFE_API_KEY)));
    await expect(askJev(options, environment)).rejects.toMatchObject({ message: 'f.classify: jev_network_error' });
  });
  it('cancels an oversized response as it streams', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(16_385)); }, cancel,
    }))));
    await expect(askJev(options, environment)).rejects.toMatchObject({ diagnostic: 'jev_response_too_large' });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('enforces the deadline while waiting for headers', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    })));
    await expect(askJev({ ...options, timeoutMs: 10 }, environment))
      .rejects.toMatchObject({ diagnostic: 'jev_timeout', completionReason: 'timeout' });
  });
  it('enforces the deadline during body reads and permits explicit fallback', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init) => Promise.resolve(new Response(new ReadableStream({
      start(c) { init.signal.addEventListener('abort', () => c.error(init.signal.reason)); },
    })))));
    expect(await askJev({ ...options, timeoutMs: 10, fallback: 'deep' }, environment))
      .toMatchObject({ choice: 'deep', fallbackReason: 'jev_timeout' });
  });
  it('does not fallback when the worker lease is lost', async () => {
    const controller = new AbortController(); const lost = new Error('lease lost'); controller.abort(lost);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(lost));
    await expect(askJev({ ...options, fallback: 'deep' }, environment, controller.signal)).rejects.toBe(lost);
  });
  it('aborts an in-flight provider request on lease loss without using fallback', async () => {
    const controller = new AbortController(); const lost = new Error('lease lost during HTTP');
    const fetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
      controller.abort(lost);
    }));
    vi.stubGlobal('fetch', fetch);
    await expect(askJev({ ...options, fallback: 'deep' }, environment, controller.signal)).rejects.toBe(lost);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    { state: 'x'.repeat(20_001) }, { question: '' }, { minConfidence: -0.1 }, { minConfidence: 1.1 },
    { timeoutMs: 0 }, { timeoutMs: 30_001 }, { timeoutMs: 1.5 }, { fallback: 'unknown' },
    { options: {} }, { options: { small: '' } }, { options: [] }, { apiKey: 'must-not-accept' },
  ])('refuses invalid author options before HTTP %#', async patch => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(askJev({ ...options, ...patch } as typeof options, environment)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('snapshots choices and canonicalizes ordering for admission replay', () => {
    const saved = classifyOptions(options);
    expect(classifyPrompt(options)).toBe(classifyPrompt({ ...options, options: { deep: 'sensitive', small: 'tiny' } }));
    expect(saved.options).not.toBe(options.options);
    expect(classifyOptions({ ...options, state: 'x'.repeat(20_000) }).state).toHaveLength(20_000);
  });
});
