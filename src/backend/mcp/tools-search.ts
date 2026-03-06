/**
 * Search, read, status, and explore tool registrations.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import type { McpServerDeps } from './types';
import type { LocationHint } from '../../shared/types';
import { PuidManager } from './puid-manager';
import { getProcessor } from '../pipeline';
import { detectLineEnding } from '../edit';
import {
  SEARCH_DESCRIPTION, READ_DESCRIPTION, EXPLORE_DESCRIPTION,
  formatSearchResults, formatExploreResults,
  formatBytes,
  MAX_READ_BYTES, PREVIEW_LINES,
} from './formatting';

export function registerSearchTool(server: McpServer, deps: McpServerDeps, puid: PuidManager): void {
  server.tool(
    'lodestone_search',
    SEARCH_DESCRIPTION,
    {
      query: z.string().describe('The search query \u2014 use natural language or code snippets'),
      silo: z.string().optional().describe('Restrict search to a specific silo name (omit to search all)'),
      maxResults: z.number().min(1).max(50).optional().describe('Maximum results to return (default: 10)'),
      startPath: z.string().optional().describe('Filter results to files under this directory path. Accepts d-prefixed reference IDs (e.g. "d3") from lodestone_explore.'),
      mode: z.enum(['hybrid', 'bm25', 'semantic', 'filepath', 'regex']).optional().describe('Search mode: hybrid (default, vector + BM25 + Levenshtein filename), bm25 (keyword-only), semantic (vector-only), filepath (filename/path matching only), or regex (full-table scan with JS RegExp)'),
      filePattern: z.string().optional().describe('Glob pattern to filter results to matching file paths (e.g. "**/*.ts")'),
      regexFlags: z.string().optional().describe('JavaScript regex flags for regex mode (default: "i")'),
    },
    async ({ query, silo, maxResults, startPath, mode, filePattern, regexFlags }) => {
      try {
        deps.notifyActivity?.({ channel: 'silo', siloName: silo });
        // Resolve d-prefixed puids in startPath to absolute paths
        let resolvedStartPath = startPath;
        if (startPath && PuidManager.isDirPuid(startPath)) {
          const resolved = puid.resolvePuid(startPath);
          if (resolved === startPath) {
            return {
              content: [{ type: 'text' as const, text: `Error: Unknown directory reference "${startPath}". It may be from a previous session.` }],
            };
          }
          resolvedStartPath = resolved;
        }

        const { results, warnings } = await deps.silo.search({
          query,
          silo,
          maxResults: maxResults ?? 10,
          startPath: resolvedStartPath,
          mode,
          filePattern,
          regexFlags,
        });

        let text = formatSearchResults(results, puid);

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
        };
      }
    },
  );
}

export function registerReadTool(server: McpServer, deps: McpServerDeps, puid: PuidManager): void {
  server.tool(
    'lodestone_read',
    READ_DESCRIPTION,
    {
      results: z.array(z.union([
        z.string(),
        z.object({
          id: z.string(),
          location: z.union([
            z.object({ type: z.literal('lines'), start: z.number().int().min(1), end: z.number().int().min(1) }),
            z.object({ type: z.literal('page'),  page: z.number().int().min(1) }),
          ]).optional(),
        }),
      ])).min(1).describe('Array of reference IDs (e.g. "r1") or objects with id and optional line range'),
    },
    async ({ results: refs }) => {
      try {
        deps.notifyActivity?.({ channel: 'silo' });
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];

        for (const entry of refs) {
          const id = typeof entry === 'string' ? entry : entry.id;
          const location = (typeof entry === 'object' ? entry.location : undefined) as LocationHint | undefined;

          // Memory puids are no longer handled locally — memory is on the cloud Worker
          if (PuidManager.isMemoryPuid(id)) {
            content.push({
              type: 'text' as const,
              text: `## ${id}\nError: Memory references (m-prefixed IDs) are handled by the Lodestone remote memory server, not this local file server.`,
            });
            continue;
          }

          // Reject directory puids — direct the LLM to use lodestone_explore
          if (PuidManager.isDirPuid(id)) {
            const dirPath = puid.resolvePuid(id);
            content.push({
              type: 'text' as const,
              text: `## ${id}: ${dirPath}\nError: "${id}" is a directory reference. Use lodestone_explore with startPath: "${id}" to browse its contents.`,
            });
            continue;
          }

          // Check for unknown or invalidated puids (moved or deleted files)
          if (/^r\d+$/.test(id)) {
            const resolved = puid.resolvePuidRecord(id);
            if (resolved === undefined) {
              content.push({ type: 'text' as const, text: `## ${id}\nError: Unknown reference "${id}". It may be from a previous session. Use lodestone_search or lodestone_explore to obtain a fresh reference.` });
              continue;
            }
            if ('error' in resolved) {
              content.push({ type: 'text' as const, text: `## ${id}\nError: ${resolved.error}` });
              continue;
            }
          }

          const filePath = puid.resolvePuid(id);
          const record = puid.getRecord(id); // may be undefined for raw-path reads
          const mime = PuidManager.imageMimeType(filePath);

          try {
            // File size check — prevent reading excessively large files
            const stat = fs.statSync(filePath);
            const hasLocation = !!location;

            if (!mime && stat.size > MAX_READ_BYTES && !hasLocation) {
              // Large text file without line range — show preview
              const sizeStr = stat.size > 1024 * 1024
                ? `${(stat.size / (1024 * 1024)).toFixed(1)} MB`
                : `${(stat.size / 1024).toFixed(0)} KB`;
              const preview = fs.readFileSync(filePath, 'utf-8').slice(0, MAX_READ_BYTES);
              const previewLines = preview.split('\n').slice(0, PREVIEW_LINES);

              // Still cache the hash so future edits work
              if (record && !record.contentHash) {
                record.contentHash = PuidManager.computeFileHash(filePath);
              }

              content.push({
                type: 'text' as const,
                text: [
                  `## ${id}: ${filePath}`,
                  `Warning: File is ${sizeStr} (exceeds ${MAX_READ_BYTES / 1024} KB read limit). Showing first ${PREVIEW_LINES} lines.`,
                  `Use location to read specific sections: { id: "${id}", location: { type: "lines", start: 101, end: 200 } }`,
                  '',
                  '```',
                  previewLines.join('\n'),
                  '```',
                ].join('\n'),
              });
            } else if (mime) {
              // Image file — return as base64 image content block
              const buf = fs.readFileSync(filePath);
              content.push({ type: 'text' as const, text: `## ${id}: ${filePath}` });
              content.push({ type: 'image' as const, data: buf.toString('base64'), mimeType: mime });
            } else {
              // Text/binary file — route through the registered reader (or
              // fall back to extractor) so binary formats return readable text.
              const processor = getProcessor(filePath);

              const hint: LocationHint = location ?? null;

              let text: string;
              if (processor.asyncReader) {
                text = await processor.asyncReader(filePath, hint);
              } else if (processor.reader) {
                text = processor.reader(filePath, hint);
              } else {
                // Fallback for processors without a reader — extract body and optionally slice lines
                if (processor.asyncExtractor) {
                  const buffer = fs.readFileSync(filePath);
                  text = (await processor.asyncExtractor(buffer)).body;
                } else if (processor.extractor) {
                  const raw = fs.readFileSync(filePath, 'utf-8');
                  text = processor.extractor(raw).body;
                } else {
                  text = fs.readFileSync(filePath, 'utf-8');
                }
                if (hint && hint.type === 'lines') {
                  const allLines = text.split('\n');
                  text = allLines.slice(hint.start - 1, hint.end).join('\n');
                }
              }

              // Lazily compute and cache the content hash on first read
              if (record && !record.contentHash) {
                record.contentHash = PuidManager.computeFileHash(filePath);
              }

              // Format output header with filetype-aware location label
              let header = `## ${id}: ${filePath}`;
              if (hint) {
                switch (hint.type) {
                  case 'lines': {
                    const lineCount = text.split('\n').length;
                    const displayEnd = hint.start + lineCount - 1;
                    header += ` (lines ${hint.start}\u2013${displayEnd})`;
                    break;
                  }
                  case 'page':  header += ` (page ${hint.page})`; break;
                }
              }
              // Annotate CRLF files so the LLM knows to preserve \r\n in edits
              if (detectLineEnding(text) === 'CRLF') {
                header += ' [CRLF line endings]';
              }
              content.push({
                type: 'text' as const,
                text: `${header}\n\`\`\`\n${text}\n\`\`\``,
              });
            }
          } catch (readErr) {
            const msg = readErr instanceof Error ? readErr.message : String(readErr);
            content.push({ type: 'text' as const, text: `## ${id}: ${filePath}\nError: ${msg}` });
          }
        }
        return { content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
        };
      }
    },
  );
}

export function registerStatusTool(server: McpServer, deps: McpServerDeps): void {
  server.tool(
    'lodestone_status',
    'Get the current status of all Lodestone silos \u2014 file counts, index sizes, and watcher states.',
    async () => {
      try {
        const { silos } = await deps.silo.status();
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
        };
      }
    },
  );
}

export function registerExploreTool(server: McpServer, deps: McpServerDeps, puid: PuidManager): void {
  server.tool(
    'lodestone_explore',
    EXPLORE_DESCRIPTION,
    {
      query: z.string().optional().describe('Search query for directory names and paths (omit for structural overview)'),
      silo: z.string().optional().describe('Restrict to a specific silo name (omit to explore all)'),
      startPath: z.string().optional().describe('Filter to directories under this path. Accepts d-prefixed reference IDs (e.g. "d3") from previous explore results.'),
      maxDepth: z.number().min(1).max(5).optional().describe('Depth of directory tree expansion (default: 2)'),
      maxResults: z.number().min(1).max(50).optional().describe('Maximum directory results to return (default: 20). Increase when browsing without a query to see more top-level directories.'),
      fullContents: z.boolean().optional().describe('When true, list every file and subdirectory with reference IDs. Defaults to true when startPath is provided, false otherwise.'),
    },
    async ({ query, silo, startPath, maxDepth, maxResults, fullContents }) => {
      try {
        deps.notifyActivity?.({ channel: 'silo', siloName: silo });
        // Resolve d-prefixed puids in startPath to absolute paths
        let resolvedStartPath = startPath;
        if (startPath && PuidManager.isDirPuid(startPath)) {
          const resolved = puid.resolvePuid(startPath);
          if (resolved === startPath) {
            return {
              content: [{ type: 'text' as const, text: `Error: Unknown directory reference "${startPath}". It may be from a previous session.` }],
            };
          }
          resolvedStartPath = resolved;
        }

        // Default fullContents to true when startPath is provided
        const effectiveFullContents = fullContents ?? (resolvedStartPath !== undefined);

        const { results, warnings } = await deps.silo.explore({
          query,
          silo,
          startPath: resolvedStartPath,
          maxDepth: maxDepth ?? 2,
          maxResults: maxResults ?? 20,
          fullContents: effectiveFullContents,
        });

        let text = formatExploreResults(results, effectiveFullContents, puid);

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
        };
      }
    },
  );
}
