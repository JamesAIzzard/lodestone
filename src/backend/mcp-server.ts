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
import { z } from 'zod';
import type { Readable, Writable } from 'node:stream';
import type { SearchResult, DirectoryResult, SiloStatus } from '../shared/types';

// ── Types ────────────────────────────────────────────────────────────────────

export interface McpServerDeps {
  /** Custom input stream (e.g. a named-pipe socket). Falls back to process.stdin. */
  input?: Readable;
  /** Custom output stream (e.g. a named-pipe socket). Falls back to process.stdout. */
  output?: Writable;
  /** Proxy search through the GUI process. */
  search: (params: {
    query: string;
    silo?: string;
    maxResults?: number;
    preset?: string;
    startPath?: string;
  }) => Promise<{ results: SearchResult[]; warnings: string[] }>;
  /** Proxy directory exploration through the GUI process. */
  explore: (params: {
    query?: string;
    silo?: string;
    startPath?: string;
    maxDepth?: number;
    maxResults?: number;
    preset?: string;
  }) => Promise<{ results: DirectoryResult[]; warnings: string[] }>;
  /** Proxy status through the GUI process. */
  status: () => Promise<{ silos: SiloStatus[] }>;
}

/** Handle returned by startMcpServer for runtime control. */
export interface McpServerHandle {
  /** Shut down the MCP server. */
  stop: () => Promise<void>;
}

// ── Formatting ───────────────────────────────────────────────────────────────

/**
 * Format search results into a readable text block for the MCP tool response.
 * Each result shows the file path, silo name, relevance score, and top chunks
 * with their section headings and line ranges.
 */
function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No results found.';
  }

  const lines: string[] = [];

  for (const result of results) {
    lines.push(`## ${result.filePath}`);
    const matchLabel = result.matchType === 'both' ? 'semantic + keyword'
      : result.matchType === 'keyword' ? 'keyword' : 'semantic';
    const sourceLabel = result.scoreSource === 'filename' ? 'filename match' : 'content match';
    lines.push(`Silo: ${result.siloName} | Relevance: ${Math.round(result.qualityScore * 100)}% | Match: ${matchLabel} | Ranked by: ${sourceLabel}`);
    lines.push('');

    for (const chunk of result.chunks) {
      const section = chunk.sectionPath.length > 0
        ? chunk.sectionPath.join(' > ')
        : '(top-level)';
      lines.push(`### ${section} (lines ${chunk.startLine}–${chunk.endLine})`);
      lines.push('```');
      lines.push(chunk.text.trim());
      lines.push('```');
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/** Format a byte count into a human-readable string. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format explore results into a tree-style text block for the MCP tool response.
 */
function formatExploreResults(results: DirectoryResult[]): string {
  if (results.length === 0) {
    return 'No directories found.';
  }

  const lines: string[] = [];

  for (const result of results) {
    lines.push(`## ${result.dirPath}`);
    lines.push(`Silo: ${result.siloName} | Relevance: ${Math.round(result.qualityScore * 100)}% | ${result.fileCount} files · ${result.subdirCount} subdirs`);
    lines.push('');

    if (result.children.length > 0) {
      lines.push(...renderTree(result.children, ''));
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/** Recursively render a directory tree with box-drawing characters. */
function renderTree(
  nodes: DirectoryResult['children'],
  prefix: string,
): string[] {
  const lines: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const connector = isLast ? '\u2514\u2500' : '\u251C\u2500';
    const stats = `${node.fileCount} files · ${node.subdirCount} subdirs`;
    lines.push(`${prefix}${connector} ${node.name}/ (${stats})`);

    if (node.children.length > 0) {
      const childPrefix = prefix + (isLast ? '   ' : '\u2502  ');
      lines.push(...renderTree(node.children, childPrefix));
    }
  }
  return lines;
}

// ── Description ──────────────────────────────────────────────────────────────

const SEARCH_DESCRIPTION = [
  'Search across locally indexed files using semantic (vector) search.',
  'Returns ranked file results with relevant code/text chunks.',
  '',
  'Search presets (controls how signals are weighted):',
  '  \u2022 balanced \u2014 general-purpose mix of semantic + keyword signals (default)',
  '  \u2022 semantic  \u2014 conceptual/prose queries; finds documents that mean the same thing even if they use different words',
  '  \u2022 keyword   \u2014 exact phrase matching; finds documents that contain the query terms, including tags and metadata',
  '  \u2022 code      \u2014 identifier and path matching; finds specific function names, class names, or file paths using substring matching',
  '',
  'Use the lodestone_status tool to see available silos and their current state.',
].join('\n');

// ── Server ───────────────────────────────────────────────────────────────────

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
      },
    },
  );

  // ── Register lodestone_search tool ──

  server.tool(
    'lodestone_search',
    SEARCH_DESCRIPTION,
    {
      query: z.string().describe('The search query \u2014 use natural language or code snippets'),
      silo: z.string().optional().describe('Restrict search to a specific silo name (omit to search all)'),
      maxResults: z.number().min(1).max(50).optional().describe('Maximum results to return (default: 10)'),
      preset: z.enum(['balanced', 'semantic', 'keyword', 'code']).optional()
        .describe('Search weight preset (default: balanced). Use "code" for source-code silos, "semantic" for prose, "keyword" for exact terms.'),
      startPath: z.string().optional().describe('Filter results to files under this directory path'),
    },
    async ({ query, silo, maxResults, preset, startPath }) => {
      try {
        const { results, warnings } = await deps.search({
          query,
          silo,
          maxResults: maxResults ?? 10,
          preset,
          startPath,
        });

        let text = formatSearchResults(results);

        // Prepend readiness warnings so the caller knows about partial results
        if (warnings.length > 0) {
          const warningBlock = warnings.map((w) => `> ${w}`).join('\n');
          text = `${warningBlock}\n\n${text}`;
        }

        return {
          content: [{ type: 'text' as const, text }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // ── Register lodestone_status tool ──

  server.tool(
    'lodestone_status',
    'Get the current status of all Lodestone silos \u2014 file counts, index sizes, and watcher states.',
    async () => {
      try {
        const { silos } = await deps.status();
        const lines: string[] = ['# Lodestone Status', ''];

        for (const silo of silos) {
          lines.push(`## ${silo.config.name}`);
          if (silo.config.description) lines.push(`Description: ${silo.config.description}`);

          // Show reconciliation progress when indexing
          if (silo.watcherState === 'indexing' && silo.reconcileProgress) {
            const { current, total } = silo.reconcileProgress;
            lines.push(`State: indexing (${current.toLocaleString()} / ${total.toLocaleString()} files)`);
          } else {
            lines.push(`State: ${silo.watcherState}`);
          }

          lines.push(`Files: ${silo.indexedFileCount.toLocaleString()}`);
          lines.push(`Chunks: ${silo.chunkCount.toLocaleString()}`);
          lines.push(`Size: ${formatBytes(silo.databaseSizeBytes)}`);
          lines.push(`Model: ${silo.resolvedModel}`);
          if (silo.modelMismatch) lines.push('Warning: Model mismatch \u2014 rebuild required');
          lines.push(`Directories: ${silo.config.directories.join(', ')}`);
          lines.push('');
        }

        if (silos.length === 0) {
          lines.push('No silos configured.');
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // ── Register lodestone_explore tool ──

  const EXPLORE_DESCRIPTION = [
    'Explore the directory structure of locally indexed silos.',
    'Returns ranked directories with nested tree views showing file/subdirectory counts.',
    '',
    'Use without a query to browse the top-level directories of a silo (ordered by depth then file count).',
    'Results are capped at maxResults — increase it if you need to see more top-level directories.',
    'Use with a query to find directories by name or path.',
    '',
    'Search presets (controls how signals are weighted):',
    '  \u2022 balanced \u2014 general-purpose mix of semantic + keyword signals (default)',
    '  \u2022 semantic  \u2014 prioritises vector similarity; best for conceptual/prose queries',
    '  \u2022 keyword   \u2014 prioritises trigram + filepath matching; best for exact directory names',
    '  \u2022 code      \u2014 boosts filepath scoring; best for source-code silos',
    '',
    'Use the lodestone_status tool to see available silos and their current state.',
  ].join('\n');

  server.tool(
    'lodestone_explore',
    EXPLORE_DESCRIPTION,
    {
      query: z.string().optional().describe('Search query for directory names and paths (omit for structural overview)'),
      silo: z.string().optional().describe('Restrict to a specific silo name (omit to explore all)'),
      startPath: z.string().optional().describe('Filter to directories under this path'),
      maxDepth: z.number().min(1).max(5).optional().describe('Depth of directory tree expansion (default: 2)'),
      maxResults: z.number().min(1).max(50).optional().describe('Maximum directory results to return (default: 20). Increase when browsing without a query to see more top-level directories.'),
      preset: z.enum(['balanced', 'semantic', 'keyword', 'code']).optional()
        .describe('Search weight preset (default: balanced). Use "code" for path-heavy, "semantic" for conceptual queries.'),
    },
    async ({ query, silo, startPath, maxDepth, maxResults, preset }) => {
      try {
        const { results, warnings } = await deps.explore({
          query,
          silo,
          startPath,
          maxDepth: maxDepth ?? 2,
          maxResults: maxResults ?? 20,
          preset,
        });

        let text = formatExploreResults(results);

        if (warnings.length > 0) {
          const warningBlock = warnings.map((w) => `> ${w}`).join('\n');
          text = `${warningBlock}\n\n${text}`;
        }

        return {
          content: [{ type: 'text' as const, text }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

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
