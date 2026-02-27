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
import { registerRememberTool, registerRecallTool, registerReviseTool, registerForgetTool, registerSkipTool, registerOrientTool, registerAgendaTool } from './tools-memory';
import { registerResources, registerGuideTool } from './resources';

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
      name: 'lodestone',
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

  // Register all tools
  registerSearchTool(server, deps, puid);
  registerReadTool(server, deps, puid);
  registerStatusTool(server, deps);
  registerExploreTool(server, deps, puid);
  registerEditTool(server, deps, puid);
  registerRememberTool(server, deps);
  registerRecallTool(server, deps, puid);
  registerReviseTool(server, deps);
  registerForgetTool(server, deps);
  registerSkipTool(server, deps);
  registerOrientTool(server, deps);
  registerAgendaTool(server, deps);

  // Register guide tool (on-demand usage guides) and resources
  registerGuideTool(server);
  registerResources(server);

  // ── Connect transport ──
  // Use custom streams when provided (named-pipe socket from mcp-wrapper),
  // otherwise fall back to process.stdin/stdout for direct stdio mode.

  const transport = new StdioServerTransport(deps.input, deps.output);
  await server.connect(transport);

  const mode = deps.input ? 'named pipe' : 'stdio';
  console.error(`[mcp] Lodestone MCP server started on ${mode}`);

  return {
    stop: async () => {
      await server.close();
      console.error('[mcp] MCP server stopped');
    },
  };
}
