import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pollHackerNewsOnce, HN_TOP_STORIES_URL, HnTransientFetchError } from '../src/hn-poller.js';

/** A recorded payload: the test never touches the network. */
const RECORDED_TOP_STORIES = '[41000001, 41000002, 41000003, 41000004, 41000005, 41000006]';

function recordingSink() {
  const submitted: Array<{ spec: unknown; event: { type: string; payload?: unknown } }> = [];
  return {
    submitted,
    async eventSubmit(spec: unknown, event: { type: string; payload?: unknown }) {
      submitted.push({ spec, event });
      return { matched: true, deduped: false };
    },
  };
}

describe('hn poller', () => {
  it('submits one event per story, up to the limit, through the journal protocol', async () => {
    const sink = recordingSink();
    const spec = { name: 'hn-monitor' };

    await pollHackerNewsOnce(spec, sink, {
      storyLimit: 3,
      fetcher: async (url) => {
        expect(url).toBe(HN_TOP_STORIES_URL);
        return RECORDED_TOP_STORIES;
      },
    });

    expect(sink.submitted).toHaveLength(3);
    expect(sink.submitted[0].event.type).toBe('hn.story_posted');
    expect(sink.submitted[0].event.payload).toEqual({ id: 41000001, type: 'story' });
    expect(sink.submitted[2].event.payload).toEqual({ id: 41000003, type: 'story' });
  });

  it('refuses a response that is not a JSON array rather than submitting nothing silently', async () => {
    const sink = recordingSink();
    await expect(
      pollHackerNewsOnce({}, sink, { fetcher: async () => '{"error":"nope"}' }),
    ).rejects.toThrow(/not an array/);
    expect(sink.submitted).toHaveLength(0);
  });

  it('does not dedupe locally — that is the kernel\'s claim, not the adapter\'s', async () => {
    const sink = recordingSink();
    await pollHackerNewsOnce({}, sink, { storyLimit: 2, fetcher: async () => '[7, 7]' });
    expect(sink.submitted).toHaveLength(2);
  });
});

/**
 * defaultFetcher is only reached when the caller does NOT pass a fetcher
 * override. These tests stub the process-global `fetch` and call
 * pollHackerNewsOnce with no fetcher, so the try/catch in defaultFetcher
 * is actually exercised. Prior review (PR #120 iter 3) caught that our
 * "SURVIVES TypeError" pin over in cli-hn-monitor.test.ts injected a
 * pre-wrapped HnTransientFetchError and would still pass if the wrap
 * were deleted. These tests close that gap.
 */
describe('defaultFetcher — wraps fetch()-level failures as HnTransientFetchError', () => {
  const origFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  afterEach(() => {
    if (origFetch === undefined) delete (globalThis as { fetch?: typeof fetch }).fetch;
    else (globalThis as { fetch: typeof fetch }).fetch = origFetch;
  });

  it('wraps a raw TypeError("fetch failed") from fetch()', async () => {
    (globalThis as any).fetch = async () => { throw new TypeError('fetch failed'); };
    let caught: unknown;
    try {
      await pollHackerNewsOnce({}, recordingSink());
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(HnTransientFetchError);
    expect((caught as HnTransientFetchError).cause).toBeInstanceOf(TypeError);
  });

  it('wraps an ECONNREFUSED-shaped error from fetch()', async () => {
    (globalThis as any).fetch = async () => {
      const err: Error & { code?: string } = new Error('connect ECONNREFUSED 127.0.0.1:80');
      err.code = 'ECONNREFUSED';
      throw err;
    };
    let caught: unknown;
    try {
      await pollHackerNewsOnce({}, recordingSink());
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(HnTransientFetchError);
    expect(String((caught as HnTransientFetchError).cause)).toMatch(/ECONNREFUSED/);
  });

  it('wraps an HTTP non-200 as HnTransientFetchError (does not throw the raw Response)', async () => {
    (globalThis as any).fetch = async () => new Response('nope', { status: 503 });
    let caught: unknown;
    try {
      await pollHackerNewsOnce({}, recordingSink());
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(HnTransientFetchError);
    expect((caught as Error).message).toMatch(/HTTP 503/);
  });
});
