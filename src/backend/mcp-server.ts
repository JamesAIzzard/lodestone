/**
 * MCP Server — exposes Lodestone search as a tool via the Model Context Protocol.
 *
 * When Lodestone is launched with `--mcp`, it starts this server instead of
 * creating an Electron window. MCP clients (Claude Desktop, VS Code extensions,
 * etc.) can then call the `lodestone_search` tool to search across all
 * configured silos.
 *
 * On Windows, Electron cannot use piped stdin (it's a GUI app — see
 * electron/electron#4218), so the transport reads/writes via a named-pipe
 * socket provided by the mcp-wrapper.js proxy process, rather than
 * process.stdin/stdout directly.
 *
 * The server uses the high-level McpServer API from @modelcontextprotocol/sdk
 * with Zod schemas for input validation.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Readable, Writable } from 'node:stream';
import type { SiloManager } from './silo-manager';
import type { LodestoneConfig } from './config';
import { resolveModelAlias } from './model-registry';

// ── Types ────────────────────────────────────────────────────────────────────

export interface McpServerDeps {
  config: LodestoneConfig;
  siloManagers: Map<string, SiloManager>;
  /** Custom input stream (e.g. a named-pipe socket). Falls back to process.stdin. */
  input?: Readable;
  /** Custom output stream (e.g. a named-pipe socket). Falls back to process.stdout. */
  output?: Writable;
}

// ── Formatting ───────────────────────────────────────────────────────────────

/**
 * Format search results into a readable text block for the MCP tool response.
 * Each result shows the file path, silo name, relevance score, and top chunks
 * with their section headings and line ranges.
 */
function formatSearchResults(
  results: Array<{
    filePath: string;
    score: number;
    matchType: string;
    siloName: string;
    chunks: Array<{
      sectionPath: string[];
      text: string;
      startLine: number;
      endLine: number;
      score: number;
    }>;
  }>,
): string {
  if (results.length === 0) {
    return 'No results found.';
  }

  const lines: string[] = [];

  for (const result of results) {
    lines.push(`## ${result.filePath}`);
    const matchLabel = result.matchType === 'both' ? 'semantic + keyword'
      : result.matchType === 'keyword' ? 'keyword' : 'semantic';
    lines.push(`Silo: ${result.siloName} | Score: ${result.score.toFixed(4)} | Match: ${matchLabel}`);
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

/**
 * Build a silo summary listing all configured silos and their descriptions,
 * for the tool's description text so the LLM knows what's searchable.
 */
function buildSiloSummary(siloManagers: Map<string, SiloManager>): string {
  if (siloManagers.size === 0) return 'No silos configured.';

  const entries: string[] = [];
  for (const [name, manager] of siloManagers) {
    const cfg = manager.getConfig();
    const desc = cfg.description ? ` — ${cfg.description}` : '';
    entries.push(`  • ${name}${desc}`);
  }

  return `Available silos:\n${entries.join('\n')}`;
}

// ── Server ───────────────────────────────────────────────────────────────────

/**
 * Create and start an MCP server that exposes Lodestone search as a tool.
 *
 * The server listens on stdin/stdout using the StdioServerTransport.
 * All logging is routed to stderr to avoid interfering with the protocol.
 *
 * @returns A cleanup function that shuts down the server.
 */
export async function startMcpServer(deps: McpServerDeps): Promise<() => Promise<void>> {
  const { config, siloManagers } = deps;

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

  const siloSummary = buildSiloSummary(siloManagers);
  const defaultModel = resolveModelAlias(config.embeddings.model);

  server.registerTool(
    'lodestone_search',
    {
      title: 'Lodestone Search',
      description: [
        'Search across locally indexed files using semantic (vector) search.',
        'Returns ranked file results with relevant code/text chunks.',
        `Default embedding model: ${defaultModel}`,
        '',
        siloSummary,
      ].join('\n'),
      inputSchema: {
        query: z.string().describe('The search query — use natural language or code snippets'),
        silo: z.string().optional().describe('Restrict search to a specific silo name (omit to search all)'),
        maxResults: z.number().min(1).max(50).optional().describe('Maximum results to return (default: 10)'),
      },
    },
    async ({ query, silo, maxResults }) => {
      const limit = maxResults ?? 10;

      // Determine which managers to search
      const managersToSearch: [string, SiloManager][] = [];
      if (silo) {
        const manager = siloManagers.get(silo);
        if (!manager) {
          return {
            content: [{ type: 'text' as const, text: `Error: silo "${silo}" not found. ${siloSummary}` }],
            isError: true,
          };
        }
        if (manager.isSleeping) {
          return {
            content: [{ type: 'text' as const, text: `Error: silo "${silo}" is sleeping. Wake it first from the Lodestone dashboard.` }],
            isError: true,
          };
        }
        managersToSearch.push([silo, manager]);
      } else {
        for (const [name, manager] of siloManagers) {
          if (!manager.isSleeping) {
            managersToSearch.push([name, manager]);
          }
        }
      }

      if (managersToSearch.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No active silos available for search. All silos may be sleeping or none are configured.' }],
          isError: true,
        };
      }

      type RawResult = {
        filePath: string;
        rrfScore: number;
        bestCosineSimilarity: number;
        matchType: string;
        siloName: string;
        chunks: Array<{
          sectionPath: string[];
          text: string;
          startLine: number;
          endLine: number;
          score: number;
        }>;
      };

      // Run search across selected silos
      const raw: RawResult[] = [];

      for (const [name, manager] of managersToSearch) {
        try {
          const siloResults = await manager.search(query, limit);
          for (const r of siloResults) {
            raw.push({
              filePath: r.filePath,
              rrfScore: r.score,
              bestCosineSimilarity: r.bestCosineSimilarity,
              matchType: r.matchType,
              siloName: name,
              chunks: r.chunks,
            });
          }
        } catch (err) {
          console.error(`[mcp] Search error in silo "${name}":`, err);
        }
      }

      // Determine the set of silos that produced results
      const silosWithResults = new Set(raw.map((r) => r.siloName));
      const crossSilo = silosWithResults.size > 1;

      // Apply cross-silo score calibration when merging results from multiple silos.
      // RRF scores are rank-based and only comparable within one silo — the top result
      // in every silo scores near 1.0 regardless of actual relevance. Multiplying by the
      // silo's mean cosine similarity discounts results from silos that are only weakly
      // relevant to the query. Mean is more robust than max — it reflects overall silo
      // relevance rather than being dominated by a single strong outlier. We use a
      // silo-level factor (not per-file) so keyword-only results aren't zeroed out.
      const siloMeanCosine = new Map<string, number>();
      if (crossSilo) {
        const siloSums = new Map<string, { sum: number; count: number }>();
        for (const r of raw) {
          if (r.bestCosineSimilarity <= 0) continue; // skip keyword-only (no cosine data)
          const entry = siloSums.get(r.siloName) ?? { sum: 0, count: 0 };
          entry.sum += r.bestCosineSimilarity;
          entry.count++;
          siloSums.set(r.siloName, entry);
        }
        for (const [name, { sum, count }] of siloSums) {
          siloMeanCosine.set(name, sum / count);
        }
      }

      const allResults = raw.map((r) => ({
        filePath: r.filePath,
        score: crossSilo ? r.rrfScore * (siloMeanCosine.get(r.siloName) ?? 0) : r.rrfScore,
        matchType: r.matchType,
        siloName: r.siloName,
        chunks: r.chunks,
      }));

      // Sort by score and limit
      allResults.sort((a, b) => b.score - a.score);
      const topResults = allResults.slice(0, limit);

      const text = formatSearchResults(topResults);

      return {
        content: [{ type: 'text' as const, text }],
      };
    },
  );

  // ── Register lodestone_status tool ──

  server.registerTool(
    'lodestone_status',
    {
      title: 'Lodestone Status',
      description: 'Get the current status of all Lodestone silos — file counts, index sizes, and watcher states.',
    },
    async () => {
      const lines: string[] = ['# Lodestone Status', ''];

      for (const [name, manager] of siloManagers) {
        const status = await manager.getStatus();
        const cfg = manager.getConfig();
        lines.push(`## ${name}`);
        if (cfg.description) lines.push(`Description: ${cfg.description}`);
        lines.push(`State: ${status.watcherState}`);
        lines.push(`Files: ${status.indexedFileCount.toLocaleString()}`);
        lines.push(`Chunks: ${status.chunkCount.toLocaleString()}`);
        lines.push(`Size: ${formatBytes(status.databaseSizeBytes)}`);
        lines.push(`Model: ${cfg.model}`);
        if (status.modelMismatch) lines.push('⚠ Model mismatch — rebuild required');
        lines.push(`Directories: ${cfg.directories.join(', ')}`);
        lines.push('');
      }

      if (siloManagers.size === 0) {
        lines.push('No silos configured.');
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );

  // ── Connect transport ──
  // Use custom streams when provided (named-pipe socket from mcp-wrapper),
  // otherwise fall back to process.stdin/stdout for direct stdio mode.

  const transport = new StdioServerTransport(deps.input, deps.output);
  await server.connect(transport);

  const mode = deps.input ? 'named pipe' : 'stdio';
  console.error(`[mcp] Lodestone MCP server started on ${mode}`);
  console.error(`[mcp] ${siloManagers.size} silo(s) available for search`);

  // Return cleanup function
  return async () => {
    await server.close();
    console.error('[mcp] MCP server stopped');
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
