import { describe, expect, it } from 'vitest';
import { pollLinearOnce, LINEAR_GRAPHQL_ENDPOINT } from '../src/linear-poller.js';

/** Recorded response — the test never touches the network. */
const RECORDED_ISSUES = JSON.stringify({
  data: {
    issues: {
      nodes: [
        { id: 'issue-uuid-1', identifier: 'ENG-1234', title: 'Fix login flow', createdAt: '2026-08-31T10:00:00Z', url: 'https://linear.app/x/issue/ENG-1234' },
        { id: 'issue-uuid-2', identifier: 'ENG-1235', title: 'Add dashboard', createdAt: '2026-08-31T10:05:00Z', url: 'https://linear.app/x/issue/ENG-1235' },
      ],
    },
  },
});

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

describe('linear poller', () => {
  it('submits one event per issue, up to the limit, through the journal protocol', async () => {
    const sink = recordingSink();
    const spec = { name: 'linear-monitor' };

    await pollLinearOnce(spec, sink, {
      token: 'lin_api_test',
      fetcher: async (query, token) => {
        expect(token).toBe('lin_api_test');
        expect(query).toContain('issues(');
        expect(query).toContain('orderBy: createdAt');
        return RECORDED_ISSUES;
      },
    });

    expect(sink.submitted).toHaveLength(2);
    expect(sink.submitted[0].event.type).toBe('linear.issue_created');
    expect((sink.submitted[0].event.payload as any).id).toBe('issue-uuid-1');
    expect((sink.submitted[0].event.payload as any).identifier).toBe('ENG-1234');
    expect((sink.submitted[1].event.payload as any).identifier).toBe('ENG-1235');
  });

  it('refuses when LINEAR_API_TOKEN is not set (fail-closed on missing auth)', async () => {
    const sink = recordingSink();
    // Clear env for this test only. Vitest per-file workers make this safe.
    const prior = process.env['LINEAR_API_TOKEN'];
    delete process.env['LINEAR_API_TOKEN'];
    try {
      await expect(pollLinearOnce({}, sink, {
        fetcher: async () => RECORDED_ISSUES,
      })).rejects.toThrow(/LINEAR_API_TOKEN/);
    } finally {
      if (prior !== undefined) process.env['LINEAR_API_TOKEN'] = prior;
    }
    expect(sink.submitted).toHaveLength(0);
  });

  it('surfaces GraphQL errors (fail-closed on server rejection)', async () => {
    const sink = recordingSink();
    await expect(pollLinearOnce({}, sink, {
      token: 't',
      fetcher: async () => JSON.stringify({
        errors: [{ message: 'Not authenticated', extensions: { code: 'AUTHENTICATION_ERROR' } }],
      }),
    })).rejects.toThrow(/Linear GraphQL error/);
    expect(sink.submitted).toHaveLength(0);
  });

  it('refuses malformed responses rather than submitting nothing silently', async () => {
    const sink = recordingSink();
    await expect(pollLinearOnce({}, sink, {
      token: 't',
      fetcher: async () => '{"data":{"issues":{"wrongkey":[]}}}',
    })).rejects.toThrow(/missing data\.issues\.nodes/);
  });

  it('passes createdAfter filter into the GraphQL query when provided', async () => {
    const sink = recordingSink();
    let capturedQuery: string | undefined;
    await pollLinearOnce({}, sink, {
      token: 't',
      createdAfter: '2026-08-31T00:00:00Z',
      fetcher: async (query) => {
        capturedQuery = query;
        return JSON.stringify({ data: { issues: { nodes: [] } } });
      },
    });
    expect(capturedQuery).toBeDefined();
    expect(capturedQuery).toContain('filter:');
    expect(capturedQuery).toContain('createdAt: { gt: "2026-08-31T00:00:00Z" }');
  });

  it('exports the GraphQL endpoint constant for humans', () => {
    expect(LINEAR_GRAPHQL_ENDPOINT).toBe('https://api.linear.app/graphql');
  });
});
