import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { PuidManager } from './puid-manager';
import { registerSearchTool } from './tools-search';
import type { McpServerDeps } from './types';

type SearchInput = {
  query: string;
  since?: string;
  until?: string;
};

function fixture() {
  const search = vi.fn(async () => ({ results: [], warnings: [] }));
  const notifyActivity = vi.fn();
  const tool = vi.fn();
  const server = { tool } as unknown as McpServer;
  const deps = { silo: { search }, notifyActivity } as unknown as McpServerDeps;
  registerSearchTool(server, deps, new PuidManager());
  const handler = tool.mock.calls[0][3] as (input: SearchInput) => Promise<CallToolResult>;
  return { handler, search, notifyActivity };
}

function firstText(result: CallToolResult): string {
  const first = result.content[0];
  return first.type === 'text' ? first.text : '';
}

describe('lodestone_search date bounds', () => {
  it('passes parsed since and until bounds to the search dependency', async () => {
    const { handler, search } = fixture();

    await handler({ query: 'test', since: '2026-08-01', until: '2026-08-02' });

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        dateFromMs: new Date(2026, 7, 1).getTime(),
        dateToMs: new Date(2026, 7, 3).getTime() - 1,
      }),
    );
  });

  it('returns a validation error without searching', async () => {
    const { handler, search, notifyActivity } = fixture();

    const result = await handler({ query: 'test', since: '2026-13-01' });

    expect(firstText(result)).toBe(
      'Error: Invalid since: expected YYYY-MM-DD or an ISO 8601 date-time.',
    );
    expect(search).not.toHaveBeenCalled();
    expect(notifyActivity).not.toHaveBeenCalled();
  });
});
