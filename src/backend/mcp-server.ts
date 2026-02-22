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
import { calibrateAndMerge, type RawSiloResult } from './search-merge';
import type { SearchWeights, SearchPreset } from '../shared/types';
import { DEFAULT_SEARCH_WEIGHTS, SEARCH_PRESETS } from '../shared/types';

// ── Types ────────────────────────────────────────────────────────────────────

export interface McpServerDeps {
  config: LodestoneConfig;
  siloManagers: Map<string, SiloManager>;
  /** Custom input stream (e.g. a named-pipe socket). Falls back to process.stdin. */
  input?: Readable;
  /** Custom output stream (e.g. a named-pipe socket). Falls back to process.stdout. */
  output?: Writable;
  /** Returns the current search weights from config (live — reads on each search). */
  getWeights?: () => SearchWeights;
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
  const { config, siloManagers, getWeights } = deps;

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
        'Search presets (controls how signals are weighted):',
        '  • balanced — general-purpose mix of semantic + keyword signals (default)',
        '  • semantic  — prioritises vector similarity; best for conceptual/prose queries',
        '  • keyword   — prioritises BM25 + trigram; best for exact terms or identifiers',
        '  • code      — boosts filepath scoring; best for source-code silos',
        '',
        siloSummary,
      ].join('\n'),
      inputSchema: {
        query: z.string().describe('The search query — use natural language or code snippets'),
        silo: z.string().optional().describe('Restrict search to a specific silo name (omit to search all)'),
        maxResults: z.number().min(1).max(50).optional().describe('Maximum results to return (default: 10)'),
        preset: z.enum(['balanced', 'semantic', 'keyword', 'code']).optional()
          .describe('Search weight preset (default: balanced). Use "code" for source-code silos, "semantic" for prose, "keyword" for exact terms.'),
      },
    },
    async ({ query, silo, maxResults, preset }) => {
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
        if (manager.isStopped) {
          return {
            content: [{ type: 'text' as const, text: `Error: silo "${silo}" is stopped. Wake it first from the Lodestone dashboard.` }],
            isError: true,
          };
        }
        managersToSearch.push([silo, manager]);
      } else {
        for (const [name, manager] of siloManagers) {
          if (!manager.isStopped) {
            managersToSearch.push([name, manager]);
          }
        }
      }

      if (managersToSearch.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No active silos available for search. All silos may be stopped or none are configured.' }],
          isError: true,
        };
      }

      // Check silo readiness — collect warnings for partial results
      const warnings: string[] = [];
      for (const [name, manager] of managersToSearch) {
        const service = manager.getEmbeddingService();
        const status = manager.getStatus();
        if (!service) {
          warnings.push(`Silo "${name}" is still initializing and not yet searchable.`);
        } else if (status.watcherState === 'indexing') {
          const prog = status.reconcileProgress;
          if (prog) {
            warnings.push(
              `Silo "${name}" is indexing (${prog.current.toLocaleString()} / ${prog.total.toLocaleString()} files) — results may be incomplete.`,
            );
          } else {
            warnings.push(`Silo "${name}" is indexing — results may be incomplete.`);
          }
        }
      }

      // Filter to silos that have an embedding service ready
      const searchableManagers = managersToSearch.filter(
        ([, m]) => m.getEmbeddingService() !== null,
      );

      if (searchableManagers.length === 0) {
        const warningText = warnings.join('\n');
        return {
          content: [{
            type: 'text' as const,
            text: `${warningText}\n\nNo silos are ready for search yet. Use lodestone_status to check progress.`,
          }],
        };
      }

      // Group silos by embedding model so we only embed the query once per model
      const byModel = new Map<string, Array<[string, SiloManager]>>();
      for (const [name, manager] of searchableManagers) {
        const model = manager.getConfig().model;
        let group = byModel.get(model);
        if (!group) { group = []; byModel.set(model, group); }
        group.push([name, manager]);
      }

      // Resolve weights from preset, defaulting to balanced
      const weights: SearchWeights = SEARCH_PRESETS[preset ?? 'balanced'];

      // Run search: embed once per model, then search all silos sharing that model
      const raw: RawSiloResult[] = [];

      for (const [, group] of byModel) {
        const service = group[0][1].getEmbeddingService()!;
        const queryVector = await service.embed(query);

        for (const [name, manager] of group) {
          try {
            const siloResults = manager.searchWithVector(queryVector, query, limit, weights);
            for (const r of siloResults) {
              raw.push({
                filePath: r.filePath,
                rrfScore: r.score,
                bestCosineSimilarity: r.bestCosineSimilarity,
                matchType: r.matchType,
                siloName: name,
                chunks: r.chunks,
                weights: r.weights,
                breakdown: r.breakdown,
              });
            }
          } catch (err) {
            console.error(`[mcp] Search error in silo "${name}":`, err);
          }
        }
      }

      // Calibrate scores across silos and sort
      const merged = calibrateAndMerge(raw);
      merged.sort((a, b) => b.score - a.score);
      const topResults = merged.slice(0, limit);

      let text = formatSearchResults(topResults);

      // Prepend readiness warnings so the caller knows about partial results
      if (warnings.length > 0) {
        const warningBlock = warnings.map(w => `> ${w}`).join('\n');
        text = `${warningBlock}\n\n${text}`;
      }

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
        const status = manager.getStatus();
        const cfg = manager.getConfig();
        lines.push(`## ${name}`);
        if (cfg.description) lines.push(`Description: ${cfg.description}`);

        // Show reconciliation progress when indexing
        if (status.watcherState === 'indexing' && status.reconcileProgress) {
          const { current, total } = status.reconcileProgress;
          lines.push(`State: indexing (${current.toLocaleString()} / ${total.toLocaleString()} files)`);
        } else {
          lines.push(`State: ${status.watcherState}`);
        }

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
