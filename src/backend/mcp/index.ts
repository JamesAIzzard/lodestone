/**
 * MCP Server — exposes Lodestone search as a tool via the Model Context Protocol.
 *
 * This server is a pure protocol adapter: it translates MCP tool calls into
 * requests to the GUI process (via the deps interface) and formats the
 * responses for the MCP client.
 *
 * It does NOT access databases, silo managers, or config directly. All state
 * lives in the GUI process and is accessed through proxy functions.
 *
 * The server uses the high-level McpServer API from @modelcontextprotocol/sdk
 * with Zod schemas for input validation.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export type { McpServerDeps, McpServerHandle } from './types';

import type { McpServerDeps, McpServerHandle } from './types';
import { PuidManager } from './puid-manager';
import { registerSearchTool, registerReadTool, registerStatusTool, registerExploreTool } from './tools-search';
import { registerEditTool } from './tools-edit';
import { registerResources, registerGuideTool } from './resources';
import { buildDatetime } from './formatting';

/**
 * Patch server.tool so every registered handler automatically appends the
 * current datetime as a footer to its last text content item. This gives the
 * LLM temporal context on every tool call without each tool having to do it.
 */
function patchWithDatetimeFooter(server: McpServer): void {
  const original = server.tool.bind(server);
  (server as unknown as Record<string, unknown>).tool = (...args: unknown[]) => {
    const lastIdx = args.length - 1;
    const handler = args[lastIdx];
    if (typeof handler === 'function') {
      args[lastIdx] = async (...handlerArgs: unknown[]) => {
        const result = await (handler as (...a: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }> }>)(...handlerArgs);
        const content = [...(result?.content ?? [])];
        const last = content[content.length - 1];
        if (last?.type === 'text') {
          const text = last.text ?? '';
          const footer = `\n\n---\n💡 Save learnings with lodestone_remember (on lodestone-memory)\n🕐 ${buildDatetime()}`;
          content[content.length - 1] = { type: 'text' as const, text: text + footer };
        }
        return { content };
      };
    }
    return (original as (...a: unknown[]) => unknown)(...args);
  };
}

/**
 * Create and start an MCP server that exposes Lodestone search as a tool.
 *
 * The server listens on stdin/stdout using the StdioServerTransport (or
 * custom streams when provided, e.g. a named-pipe socket from mcp-wrapper).
 * All logging is routed to stderr to avoid interfering with the protocol.
 */
export async function startMcpServer(deps: McpServerDeps): Promise<McpServerHandle> {
  const server = new McpServer(
    {
      name: 'lodestone-files',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  const puid = new PuidManager();

  // Append current datetime to every tool response automatically
  patchWithDatetimeFooter(server);

  // Register all tools
  registerSearchTool(server, deps, puid);
  registerReadTool(server, deps, puid);
  registerStatusTool(server, deps);
  registerExploreTool(server, deps, puid);
  registerEditTool(server, deps, puid);

  // Register guide tool (on-demand usage guides) and resources
  registerGuideTool(server);
  registerResources(server);

  // ── Connect transport ──
  // Use custom streams when provided (named-pipe socket from mcp-wrapper),
  // otherwise fall back to process.stdin/stdout for direct stdio mode.

  const transport = new StdioServerTransport(deps.input, deps.output);
  await server.connect(transport);

  const mode = deps.input ? 'named pipe' : 'stdio';
  console.error(`[mcp] lodestone-files MCP server started on ${mode}`);

  return {
    stop: async () => {
      await server.close();
      console.error('[mcp] MCP server stopped');
    },
  };
}
