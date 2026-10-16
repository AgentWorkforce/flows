import { rmSync } from 'node:fs';
import { expect, it } from 'vitest';
import { JournalClient } from '../src/journal-client.js';
import { HELLO_SPEC, sendResult, sockPath, startLoopback } from './journal-client-loopback.js';

// F1: a shared daemon spawns `f.run` steps in the environment of the CLI that
// started it. The client sends its own environment on run.start / run.resume
// so each run's steps get THAT run's env -- but only to a daemon that lists
// `step_env`, because an older one refuses unknown params outright.
it.each([
  ['a daemon that predates the feature', undefined, false],
  ['a daemon that advertises it', ['step_env'], true],
] as const)('sends the step env only to %s', async (_name, features, sent) => {
  const path = sockPath();
  const received: Record<string, unknown>[] = [];
  const server = startLoopback(path, {
    hello: ctx => sendResult(ctx, { protocol: 0, server: 'relayflowd', ...(features === undefined ? {} : { features }) }),
    'run.start': (ctx, params) => { received.push(params); sendResult(ctx, { run_id: 'run-01', status: 'completed' }); },
    'run.resume': (ctx, params) => { received.push(params); sendResult(ctx, { run_id: 'run-01', status: 'completed' }); },
  });
  const client = new JournalClient(path);
  process.env.FLOWS_STEP_ENV_PROBE = 'from-this-cli';
  try {
    await client.connect();
    await client.hello('feature-gate');
    await client.runStart(HELLO_SPEC);
    await client.runResume('run-01');
    expect(received).toHaveLength(2);
    for (const params of received) {
      if (sent) expect((params['env'] as Record<string, string>)['FLOWS_STEP_ENV_PROBE']).toBe('from-this-cli');
      else expect(params).not.toHaveProperty('env');
    }
  } finally {
    delete process.env.FLOWS_STEP_ENV_PROBE;
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(path, { force: true });
  }
});

it('keeps plain runs with delivered secrets working on an older daemon', async () => {
  const path = sockPath();
  const received: Record<string, unknown>[] = [];
  const server = startLoopback(path, {
    hello: ctx => sendResult(ctx, { protocol: 0, server: 'relayflowd', features: ['step_env'] }),
    'run.start': (ctx, params) => { received.push(params); sendResult(ctx, { run_id: 'run-01', status: 'completed' }); },
    'run.resume': (ctx, params) => { received.push(params); sendResult(ctx, { run_id: 'run-01', status: 'completed' }); },
  });
  const client = new JournalClient(path);
  const priorToken = process.env.NATIVE_API_TOKEN;
  const priorManifest = process.env.RELAY_SECRET_ENV_NAMES;
  process.env.NATIVE_API_TOKEN = 'native-secret';
  process.env.RELAY_SECRET_ENV_NAMES = '["NATIVE_API_TOKEN"]';
  try {
    await client.connect();
    await client.hello('secret-feature-gate');
    expect(client.supportsFeature('step_secret_scoping')).toBe(false);
    await client.runStart(HELLO_SPEC);
    await client.runResume('run-01');
    expect(received).toHaveLength(2);
    for (const params of received) {
      expect((params['env'] as Record<string, string>)['NATIVE_API_TOKEN']).toBe('native-secret');
    }
  } finally {
    if (priorToken === undefined) delete process.env.NATIVE_API_TOKEN;
    else process.env.NATIVE_API_TOKEN = priorToken;
    if (priorManifest === undefined) delete process.env.RELAY_SECRET_ENV_NAMES;
    else process.env.RELAY_SECRET_ENV_NAMES = priorManifest;
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(path, { force: true });
  }
});

it('removes withheld delivered names from the manifest and refuses their grants at admission', async () => {
  const path = sockPath();
  const received: Record<string, unknown>[] = [];
  const server = startLoopback(path, {
    hello: ctx => sendResult(ctx, { protocol: 0, server: 'relayflowd',
      features: ['step_env', 'step_secret_scoping'], det_withheld: ['HIDDEN_SECRET'] }),
    'run.start': (ctx, params) => { received.push(params); sendResult(ctx, { run_id: 'run-01', status: 'completed' }); },
    'run.resume': (ctx, params) => { received.push(params); sendResult(ctx, { run_id: 'run-01', status: 'completed' }); },
  });
  const client = new JournalClient(path);
  const saved = { ...process.env };
  Object.assign(process.env, {
    HIDDEN_SECRET: 'withheld-value', VISIBLE_SECRET: 'visible-value',
    RELAY_SECRET_ENV_NAMES: '["HIDDEN_SECRET","VISIBLE_SECRET"]',
  });
  try {
    await client.connect();
    await client.hello('withheld-delivered');
    await client.runStart(HELLO_SPEC);
    await client.runResume('run-01');
    expect(received).toHaveLength(2);
    for (const params of received) {
      const env = params['env'] as Record<string, string>;
      expect(env).not.toHaveProperty('HIDDEN_SECRET');
      expect(env.RELAY_SECRET_ENV_NAMES).toBe('["VISIBLE_SECRET"]');
    }
    const granted = { ...HELLO_SPEC,
      steps: HELLO_SPEC.steps.map(step => ({ ...step, secrets: ['HIDDEN_SECRET'] })) };
    expect(() => client.runStart(granted)).toThrow('withheld by the daemon');
    expect(received).toHaveLength(2);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(path, { force: true });
  }
});

it('never forwards CLI-only signal or model-login metadata on run.start or run.resume', async () => {
  const path = sockPath();
  const received: Record<string, unknown>[] = [];
  const server = startLoopback(path, {
    hello: ctx => sendResult(ctx, { protocol: 0, server: 'relayflowd', features: ['step_env', 'step_secret_scoping'] }),
    'run.start': (ctx, params) => { received.push(params); sendResult(ctx, { run_id: 'run-01', status: 'completed' }); },
    'run.resume': (ctx, params) => { received.push(params); sendResult(ctx, { run_id: 'run-01', status: 'completed' }); },
  });
  const client = new JournalClient(path);
  const prior = process.env.RELAYFLOW_V2_SIGNAL_READ_TOKEN;
  const priorPlatform = process.env.RELAY_PLATFORM_AGENT_ENV_NAMES;
  process.env.RELAYFLOW_V2_SIGNAL_READ_TOKEN = 'private-signal-token';
  process.env.RELAY_PLATFORM_AGENT_ENV_NAMES = '[]';
  try {
    await client.connect();
    await client.hello('signal-token-gate');
    await client.runStart(HELLO_SPEC);
    await client.runResume('run-01');
    expect(received).toHaveLength(2);
    for (const params of received) {
      expect(params).toHaveProperty('env');
      expect(params['env']).not.toHaveProperty('RELAYFLOW_V2_SIGNAL_READ_TOKEN');
      expect(params['env']).not.toHaveProperty('RELAY_PLATFORM_AGENT_ENV_NAMES');
    }
  } finally {
    if (prior === undefined) delete process.env.RELAYFLOW_V2_SIGNAL_READ_TOKEN;
    else process.env.RELAYFLOW_V2_SIGNAL_READ_TOKEN = prior;
    if (priorPlatform === undefined) delete process.env.RELAY_PLATFORM_AGENT_ENV_NAMES;
    else process.env.RELAY_PLATFORM_AGENT_ENV_NAMES = priorPlatform;
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(path, { force: true });
  }
});

it('refuses a declared secret grant on an older daemon before run.start', async () => {
  const path = sockPath();
  let starts = 0;
  const server = startLoopback(path, {
    hello: ctx => sendResult(ctx, { protocol: 0, server: 'relayflowd', features: ['step_env'] }),
    'run.start': ctx => { starts++; sendResult(ctx, { run_id: 'run-01', status: 'completed' }); },
  });
  const client = new JournalClient(path);
  const priorToken = process.env.NATIVE_API_TOKEN;
  const priorManifest = process.env.RELAY_SECRET_ENV_NAMES;
  process.env.NATIVE_API_TOKEN = 'native-secret';
  process.env.RELAY_SECRET_ENV_NAMES = '["NATIVE_API_TOKEN"]';
  try {
    await client.connect();
    await client.hello('declared-secret-feature-gate');
    expect(() => client.runStart({ ...HELLO_SPEC, steps: [
      { ...HELLO_SPEC.steps[0]!, secrets: ['NATIVE_API_TOKEN'] },
    ] })).toThrow('step_secret_scoping');
    expect(starts).toBe(0);
  } finally {
    if (priorToken === undefined) delete process.env.NATIVE_API_TOKEN;
    else process.env.NATIVE_API_TOKEN = priorToken;
    if (priorManifest === undefined) delete process.env.RELAY_SECRET_ENV_NAMES;
    else process.env.RELAY_SECRET_ENV_NAMES = priorManifest;
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(path, { force: true });
  }
});

it('refuses a grant absent from the delivered-name manifest before run.start', async () => {
  const path = sockPath();
  let starts = 0;
  const server = startLoopback(path, {
    hello: ctx => sendResult(ctx, { protocol: 0, server: 'relayflowd', features: ['step_env', 'step_secret_scoping'] }),
    'run.start': ctx => { starts++; sendResult(ctx, { run_id: 'run-01', status: 'completed' }); },
  });
  const client = new JournalClient(path);
  const priorToken = process.env.NATIVE_API_TOKEN;
  const priorManifest = process.env.RELAY_SECRET_ENV_NAMES;
  process.env.NATIVE_API_TOKEN = 'native-secret';
  process.env.RELAY_SECRET_ENV_NAMES = '["NATIVE_API_TOKEN"]';
  try {
    await client.connect();
    await client.hello('unknown-secret-gate');
    expect(client.supportsFeature('step_secret_scoping')).toBe(true);
    expect(() => client.runStart({ ...HELLO_SPEC, steps: [
      { ...HELLO_SPEC.steps[0]!, secrets: ['OTHER_TOKEN'] },
    ] })).toThrow('OTHER_TOKEN');
    expect(starts).toBe(0);
  } finally {
    if (priorToken === undefined) delete process.env.NATIVE_API_TOKEN;
    else process.env.NATIVE_API_TOKEN = priorToken;
    if (priorManifest === undefined) delete process.env.RELAY_SECRET_ENV_NAMES;
    else process.env.RELAY_SECRET_ENV_NAMES = priorManifest;
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(path, { force: true });
  }
});

it('checks isolated run grants against the peer handshake before admission', async () => {
  const path = sockPath();
  let hellos = 0;
  let starts = 0;
  const server = startLoopback(path, {
    hello: ctx => {
      hellos++;
      sendResult(ctx, { protocol: 0, server: 'relayflowd',
        features: ['step_env', 'step_secret_scoping'], det_withheld: ['HIDDEN_SECRET'] });
    },
    'run.start': ctx => { starts++; sendResult(ctx, { run_id: 'run-01', status: 'completed' }); },
  });
  const client = new JournalClient(path);
  const priorToken = process.env.HIDDEN_SECRET;
  const priorManifest = process.env.RELAY_SECRET_ENV_NAMES;
  process.env.HIDDEN_SECRET = 'withheld-value';
  process.env.RELAY_SECRET_ENV_NAMES = '["HIDDEN_SECRET"]';
  try {
    await client.connect();
    await client.hello('isolated-secret-grant');
    const spec = { ...HELLO_SPEC, steps: [
      { ...HELLO_SPEC.steps[0]!, secrets: ['HIDDEN_SECRET'] },
    ] };
    await expect(client.runStart(spec, undefined, undefined, false, true))
      .rejects.toThrow('withheld by the daemon');
    expect(hellos).toBe(2);
    expect(starts).toBe(0);
  } finally {
    if (priorToken === undefined) delete process.env.HIDDEN_SECRET;
    else process.env.HIDDEN_SECRET = priorToken;
    if (priorManifest === undefined) delete process.env.RELAY_SECRET_ENV_NAMES;
    else process.env.RELAY_SECRET_ENV_NAMES = priorManifest;
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(path, { force: true });
  }
});
