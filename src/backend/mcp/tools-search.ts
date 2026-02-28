/**
 * Search, read, status, and explore tool registrations.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import type { McpServerDeps } from './types';
import { PuidManager } from './puid-manager';
import { getProcessor } from '../pipeline';
import {
  SEARCH_DESCRIPTION, READ_DESCRIPTION, EXPLORE_DESCRIPTION,
  formatSearchResults, formatExploreResults,
  formatBytes, memoryNudge, truncateMemoryBody, priorityLabel, statusLabel,
  MAX_READ_BYTES, PREVIEW_LINES, CROSS_SEARCH_THRESHOLD,
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
              isError: true,
            };
          }
          resolvedStartPath = resolved;
        }

        const { results, warnings } = await deps.search({
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

        // Memory sidebar: append top 5 memory matches for supported modes
        const sidebarModes = new Set(['hybrid', 'bm25', 'semantic', undefined]);
        if (deps.isMemoryConnected?.() && sidebarModes.has(mode)) {
          try {
            const memories = (await deps.memoryRecall({ query, maxResults: 5 }))
              .filter(m => m.score >= CROSS_SEARCH_THRESHOLD);
            if (memories.length > 0) {
              const memLines = [
                '',
                '---',
                'Related memories (use lodestone_recall for deeper search):',
                '',
              ];
              for (const m of memories) {
                const suffixes: string[] = [];
                if (m.actionDate) {
                  let s = `Action: ${m.actionDate}`;
                  if (m.recurrence) s += ` (${m.recurrence})`;
                  suffixes.push(s);
                }
                if (m.priority) suffixes.push(`Priority: ${priorityLabel(m.priority)}`);
                const suffix = suffixes.length > 0 ? ` | ${suffixes.join(' | ')}` : '';
                memLines.push(`- [m${m.id}] ${m.topic}${suffix}`);
                memLines.push(`  ${truncateMemoryBody(m.body)}`);
                memLines.push('');
              }
              text += memLines.join('\n');
            }
          } catch {
            // Memory query failure should not break search results
          }
        }

        return {
          content: [{ type: 'text' as const, text: text + memoryNudge(deps) }],
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
          startLine: z.number().int().min(1).optional(),
          endLine: z.number().int().min(1).optional(),
        }),
      ])).min(1).describe('Array of reference IDs (e.g. "r1") or objects with id and optional line range'),
    },
    async ({ results: refs }) => {
      try {
        deps.notifyActivity?.({ channel: 'silo' });
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];

        for (const entry of refs) {
          const id = typeof entry === 'string' ? entry : entry.id;
          const startLine = typeof entry === 'object' ? entry.startLine : undefined;
          const endLine = typeof entry === 'object' ? entry.endLine : undefined;

          // Resolve memory puids — fetch full body from memory database
          if (PuidManager.isMemoryPuid(id)) {
            const memId = PuidManager.parseMemoryId(id);
            try {
              const memory = await deps.memoryGetById({ id: memId });
              if (!memory) {
                content.push({
                  type: 'text' as const,
                  text: `## ${id}\nError: Memory ${memId} not found.`,
                });
              } else if (memory.deletedAt) {
                // Soft-deleted memory — show body with deletion notice so reference
                // chains through deleted memories remain navigable.
                const deletedNote = memory.deletionReason
                  ? `Deleted: ${memory.deletedAt} — ${memory.deletionReason}`
                  : `Deleted: ${memory.deletedAt}`;
                content.push({
                  type: 'text' as const,
                  text: [
                    `## ${id}: ${memory.topic} [DELETED]`,
                    `> ⚠️ ${deletedNote}`,
                    '',
                    memory.body,
                  ].join('\n'),
                });
              } else {
                const memMeta = [`Confidence: ${memory.confidence}`, `Updated: ${memory.updatedAt}`];
                if (memory.actionDate) {
                  let actionStr = `Action: ${memory.actionDate}`;
                  if (memory.recurrence) actionStr += ` (${memory.recurrence})`;
                  memMeta.push(actionStr);
                }
                if (memory.priority) memMeta.push(`Priority: ${priorityLabel(memory.priority)}`);
                if (memory.status) memMeta.push(`Status: ${statusLabel(memory.status)}`);
                if (memory.completedOn) memMeta.push(`Completed: ${memory.completedOn}`);
                const lines = [
                  `## ${id}: ${memory.topic}`,
                  memory.body,
                  '',
                  `_${memMeta.join(' | ')}_`,
                ];

                // Append related-memory hints on single m-id reads only (batch reads stay clean).
                if (refs.length === 1 && deps.memoryFindRelated) {
                  try {
                    const related = await deps.memoryFindRelated({ id: memId, topN: 5 });
                    if (related.length > 0) {
                      lines.push('');
                      lines.push('Related memories (top 5 by similarity):');
                      for (const r of related) {
                        const pct = Math.round(r.similarity * 100);
                        lines.push(`  [m${r.id}] ${r.topic} (${pct}%)`);
                      }
                    }
                  } catch {
                    // Related hints are best-effort — never break the read
                  }
                }

                content.push({ type: 'text' as const, text: lines.join('\n') });
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              content.push({ type: 'text' as const, text: `## ${id}\nError: ${msg}` });
            }
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

          // Check for invalidated puids (moved or deleted files)
          if (/^r\d+$/.test(id)) {
            const resolved = puid.resolvePuidRecord(id);
            if (resolved && 'error' in resolved) {
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
            const hasLineRange = !!(startLine || endLine);

            if (!mime && stat.size > MAX_READ_BYTES && !hasLineRange) {
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
                  `Use line ranges to read specific sections: { id: "${id}", startLine: 101, endLine: 200 }`,
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
              // Text/binary file — route through the registered extractor so
              // binary formats (e.g. PDF) return human-readable body text.
              const processor = getProcessor(filePath);
              let text: string;
              if (processor.asyncExtractor) {
                const buffer = fs.readFileSync(filePath);
                text = (await processor.asyncExtractor(buffer)).body;
              } else if (processor.extractor) {
                const raw = fs.readFileSync(filePath, 'utf-8');
                text = processor.extractor(raw).body;
              } else {
                text = fs.readFileSync(filePath, 'utf-8');
              }

              // Lazily compute and cache the content hash on first read
              if (record && !record.contentHash) {
                record.contentHash = PuidManager.computeFileHash(filePath);
              }

              if (hasLineRange) {
                const allLines = text.split('\n');
                const start = (startLine ?? 1) - 1; // convert to 0-indexed
                const end = endLine ?? allLines.length;
                const slice = allLines.slice(start, end);
                content.push({
                  type: 'text' as const,
                  text: `## ${id}: ${filePath} (lines ${start + 1}\u2013${end})\n\`\`\`\n${slice.join('\n')}\n\`\`\``,
                });
              } else {
                content.push({
                  type: 'text' as const,
                  text: `## ${id}: ${filePath}\n\`\`\`\n${text}\n\`\`\``,
                });
              }
            }
          } catch (readErr) {
            const msg = readErr instanceof Error ? readErr.message : String(readErr);
            content.push({ type: 'text' as const, text: `## ${id}: ${filePath}\nError: ${msg}` });
          }
        }

        const nudge = memoryNudge(deps);
        if (nudge) content.push({ type: 'text' as const, text: nudge });
        return { content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
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
          content: [{ type: 'text' as const, text: lines.join('\n') + memoryNudge(deps) }],
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
              isError: true,
            };
          }
          resolvedStartPath = resolved;
        }

        // Default fullContents to true when startPath is provided
        const effectiveFullContents = fullContents ?? (resolvedStartPath !== undefined);

        const { results, warnings } = await deps.explore({
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
          content: [{ type: 'text' as const, text: text + memoryNudge(deps) }],
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
}
