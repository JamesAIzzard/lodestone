import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { PuidManager } from './puid-manager';
import { registerExploreTool, registerSearchTool, registerStatusTool } from './tools-search';
import type { McpServerDeps } from './types';

type SearchInput = {
  query: string;
  silo?: string | string[];
  since?: string;
  until?: string;
};

function fixture() {
  const search = vi.fn(async () => ({ results: [], warnings: [] }));
  const notifyActivity = vi.fn();
  const tool = vi.fn();
  const server = { tool } as unknown as McpServer;
  const deps = { silo: { search }, notifyActivity } as unknown as McpServerDeps;
  const puid = new PuidManager();
  registerSearchTool(server, deps, puid);
  const handler = tool.mock.calls[0][3] as (input: SearchInput) => Promise<CallToolResult>;
  return { handler, search, notifyActivity, puid };
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

describe('lodestone_search silo selection', () => {
  it('resolves references and passes a mixed subset as silo names', async () => {
    const { handler, search, puid } = fixture();
    puid.assignSiloPuid('alpha');

    await handler({ query: 'test', silo: ['s1', 'notes'] });

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ silo: ['alpha', 'notes'] }));
  });

  it('rejects an unknown reference without searching or notifying activity', async () => {
    const { handler, search, notifyActivity } = fixture();

    const result = await handler({ query: 'test', silo: 's9' });

    expect(firstText(result)).toBe(
      'Error: Unknown silo reference "s9". Use lodestone_status to obtain a fresh reference.',
    );
    expect(search).not.toHaveBeenCalled();
    expect(notifyActivity).not.toHaveBeenCalled();
  });

  it('targets one activity card for one silo and all cards for a subset', async () => {
    const { handler, notifyActivity } = fixture();

    await handler({ query: 'test', silo: 'notes' });
    expect(notifyActivity).toHaveBeenLastCalledWith({ channel: 'silo', siloName: 'notes' });

    await handler({ query: 'test', silo: ['notes', 'mail'] });
    expect(notifyActivity).toHaveBeenLastCalledWith({ channel: 'silo', siloName: undefined });
  });
});

describe('lodestone_status silo references', () => {
  it('labels status headings in status order', async () => {
    const tool = vi.fn();
    const server = { tool } as unknown as McpServer;
    const status = vi.fn(async () => ({
      silos: ['alpha', 'beta'].map((name) => ({
        config: {
          name,
          contentDescription: '',
          readOnly: false,
          indexedDirectories: [] as string[],
        },
        watcherState: 'ready',
        available: true,
        indexCaughtUp: true,
        indexedFileCount: 0,
        chunkCount: 0,
        databaseSizeBytes: 0,
      })),
    }));
    const deps = { silo: { status } } as unknown as McpServerDeps;
    registerStatusTool(server, deps, new PuidManager());
    const handler = tool.mock.calls[0][2] as () => Promise<CallToolResult>;

    const output = firstText(await handler());

    expect(output).toContain('## s1: alpha');
    expect(output).toContain('## s2: beta');
  });
});

describe('lodestone_explore silo selection', () => {
  it('resolves references and forwards the selected silo names', async () => {
    const explore = vi.fn(async () => ({ results: [], warnings: [] }));
    const notifyActivity = vi.fn();
    const tool = vi.fn();
    const server = { tool } as unknown as McpServer;
    const deps = { silo: { explore }, notifyActivity } as unknown as McpServerDeps;
    const puid = new PuidManager();
    puid.assignSiloPuid('alpha');
    registerExploreTool(server, deps, puid);
    const handler = tool.mock.calls[0][3] as (input: {
      silo?: string | string[];
    }) => Promise<CallToolResult>;

    await handler({ silo: ['s1', 'notes'] });

    expect(explore).toHaveBeenCalledWith(expect.objectContaining({ silo: ['alpha', 'notes'] }));
    expect(notifyActivity).toHaveBeenCalledWith({ channel: 'silo', siloName: undefined });
  });
});
