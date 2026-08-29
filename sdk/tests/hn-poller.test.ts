import { describe, expect, it } from 'vitest';
import { pollHackerNewsOnce, HN_TOP_STORIES_URL } from '../src/hn-poller.js';

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
