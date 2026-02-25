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
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { SearchResult, DirectoryResult, SiloStatus } from '../shared/types';
import type { EditOperation, EditResult } from './edit';

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
    startPath?: string;
  }) => Promise<{ results: SearchResult[]; warnings: string[] }>;
  /** Proxy directory exploration through the GUI process. */
  explore: (params: {
    query?: string;
    silo?: string;
    startPath?: string;
    maxDepth?: number;
    maxResults?: number;
    fullContents?: boolean;
  }) => Promise<{ results: DirectoryResult[]; warnings: string[] }>;
  /** Proxy status through the GUI process. */
  status: () => Promise<{ silos: SiloStatus[] }>;
  /** Proxy edit operations through the GUI process. */
  edit: (params: {
    operation: EditOperation;
    contextLines: number;
    siloDirectories: string[];
  }) => Promise<EditResult>;
  /** Get config defaults (e.g. contextLines) from the GUI process. */
  getDefaults: () => Promise<{ contextLines: number }>;
}

/** Handle returned by startMcpServer for runtime control. */
export interface McpServerHandle {
  /** Shut down the MCP server. */
  stop: () => Promise<void>;
}

// ── Puid tracking ────────────────────────────────────────────────────────────

/**
 * Structured record stored for each puid.
 *
 * The contentHash is computed lazily — not at puid assignment time during
 * search or explore, but on the first lodestone_read or lodestone_edit call
 * that targets the puid. This avoids reading and hashing every file during
 * explore calls that may list hundreds of files.
 */
interface PuidRecord {
  /** Absolute filesystem path. */
  filepath: string;
  /** SHA-256 hex digest of the file's raw bytes, computed lazily on first read/edit. Undefined for directories. */
  contentHash?: string;
  /** True if this puid has been invalidated by a move or delete. */
  invalidated?: boolean;
  /** Original path before invalidation, for error messages. */
  invalidatedPath?: string;
}

/**
 * Session-scoped puid (persistent unique ID) tracking.
 *
 * Two monotonic counters — never reset during a session:
 *   r1, r2, r3... for files (from search results and explore file listings)
 *   d1, d2, d3... for directories (from explore results)
 *
 * Both share a single forward lookup map (puid → record) so lodestone_read
 * and lodestone_explore can resolve any puid regardless of origin.
 *
 * Reverse maps (path → puid) ensure the same path always returns the same
 * puid within a session — re-exploring a directory reuses its existing puid
 * rather than minting a fresh one.
 */
let rCounter = 0;
let dCounter = 0;
const puidMap = new Map<string, PuidRecord>();     // puid → record
const filePathToPuid = new Map<string, string>();   // absolute file path → r-puid
const dirPathToPuid = new Map<string, string>();    // normalised dir path → d-puid

/** Strip trailing path separators for consistent map keys. */
function normaliseDirPath(p: string): string {
  return p.replace(/[\\/]+$/, '');
}

/** Compute SHA-256 hex digest of a file's raw bytes. */
function computeFileHash(filepath: string): string {
  const buffer = fs.readFileSync(filepath);
  return createHash('sha256').update(buffer).digest('hex');
}

function assignFilePuid(filePath: string): string {
  const existing = filePathToPuid.get(filePath);
  if (existing) return existing;
  rCounter++;
  const puid = `r${rCounter}`;
  puidMap.set(puid, { filepath: filePath });
  filePathToPuid.set(filePath, puid);
  return puid;
}

function assignDirPuid(dirPath: string): string {
  const key = normaliseDirPath(dirPath);
  const existing = dirPathToPuid.get(key);
  if (existing) return existing;
  dCounter++;
  const puid = `d${dCounter}`;
  puidMap.set(puid, { filepath: dirPath });
  dirPathToPuid.set(key, puid);
  return puid;
}

/**
 * Resolve a puid to its record, checking for invalidation.
 * Returns the PuidRecord, an error object, or undefined for unknown puids.
 */
function resolvePuidRecord(id: string): PuidRecord | { error: string } | undefined {
  const record = puidMap.get(id);
  if (!record) return undefined;
  if (record.invalidated) {
    return {
      error: `Puid ${id} has been invalidated. The file at ${record.invalidatedPath} was moved or deleted. Search again to obtain a fresh reference.`,
    };
  }
  return record;
}

/**
 * Resolve a puid to its filepath, falling back to treating the id as a literal path.
 * Does NOT check invalidation — use resolvePuidRecord for puid-addressed operations.
 */
function resolvePuid(id: string): string {
  const record = puidMap.get(id);
  return record ? record.filepath : id;
}

/** Mark a single puid as invalidated (direct invalidation after move/delete). */
function invalidatePuid(puid: string): void {
  const record = puidMap.get(puid);
  if (record) {
    record.invalidated = true;
    record.invalidatedPath = record.filepath;
  }
}

/** Scan all puids for records matching a filepath and invalidate them (path-scan). */
function invalidateByPath(sourcePath: string): void {
  const resolved = path.resolve(sourcePath);
  for (const [, record] of puidMap) {
    if (!record.invalidated && path.resolve(record.filepath) === resolved) {
      record.invalidated = true;
      record.invalidatedPath = record.filepath;
    }
  }
  // Remove from reverse lookup
  filePathToPuid.delete(sourcePath);
}

function isDirPuid(id: string): boolean {
  return /^d\d+$/.test(id);
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

/** Return the MIME type if the file is an image, or null for text files. */
function imageMimeType(filePath: string): string | null {
  return IMAGE_MIME[path.extname(filePath).toLowerCase()] ?? null;
}

// ── Formatting ───────────────────────────────────────────────────────────────

/**
 * Format search results into a readable text block for the MCP tool response.
 *
 * Each result is prefixed with a puid (r1, r2, ...) for use with lodestone_read,
 * followed by the full absolute file path, silo name, and score breakdown.
 */
function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No results found.';
  }

  const lines: string[] = [];

  for (const result of results) {
    const puid = assignFilePuid(result.filePath);
    lines.push(`## ${puid}: ${result.filePath}`);
    const pct = Math.round(result.score * 100);
    const sourceLabel = result.scoreSource === 'filename' ? 'filename' : 'content';
    const scorerLabel = result.scoreSource === 'filename'
      ? 'levenshtein'
      : (result.chunks[0]?.scores.bestScorer ?? 'semantic');
    lines.push(`Silo: ${result.siloName} | Score: ${pct}% (${sourceLabel}, ${scorerLabel})`);
    lines.push('');

    for (const chunk of result.chunks) {
      const section = chunk.sectionPath.length > 0
        ? chunk.sectionPath.join(' > ')
        : '(top-level)';
      lines.push(`### ${section} (lines ${chunk.startLine}\u2013${chunk.endLine})`);
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

/** Get the normalised parent directory path, or null if at a root. */
function getParentDirPath(dirPath: string): string | null {
  const normalized = normaliseDirPath(dirPath);
  const parent = path.dirname(normalized);
  if (parent === normalized || parent === '.') return null;
  return parent;
}

/**
 * Format explore results into a text block for the MCP tool response.
 *
 * When fullContents is false: compact tree with d-puids on directories.
 * When fullContents is true: flat listing with d-puids on subdirectories
 * and r-puids on files.
 */
function formatExploreResults(results: DirectoryResult[], fullContents: boolean): string {
  if (results.length === 0) {
    return 'No directories found.';
  }

  const lines: string[] = [];

  for (const result of results) {
    const dirPuid = assignDirPuid(result.dirPath);

    // Breadcrumb: look up parent puid (normalised for consistent matching)
    const parentPath = getParentDirPath(result.dirPath);
    const parentPuid = parentPath ? dirPathToPuid.get(parentPath) : null;
    const parentSuffix = parentPuid ? ` (parent: ${parentPuid})` : '';

    lines.push(`## ${dirPuid}: ${result.dirPath}${parentSuffix}`);
    const pct = Math.round(result.score * 100);
    const sourceLabel = result.scoreSource === 'keyword' ? 'keyword' : 'segment';
    lines.push(`Silo: ${result.siloName} | Score: ${pct}% (${sourceLabel}) | ${result.fileCount} files \u00B7 ${result.subdirCount} subdirs`);
    lines.push('');

    if (fullContents) {
      // Flat listing: subdirectories first, then files
      if (result.children.length > 0) {
        for (const child of result.children) {
          const childPuid = assignDirPuid(child.path);
          const stats = `${child.fileCount} files \u00B7 ${child.subdirCount} subdirs`;
          lines.push(`  ${childPuid.padEnd(5)} ${child.name}/`.padEnd(35) + stats);
        }
      }
      if (result.files && result.files.length > 0) {
        for (const file of result.files) {
          const filePuid = assignFilePuid(file.filePath);
          lines.push(`  ${filePuid.padEnd(5)} ${file.fileName}`);
        }
      }
      if (result.children.length > 0 || (result.files && result.files.length > 0)) {
        lines.push('');
      }
    } else {
      // Compact tree with d-puids
      if (result.children.length > 0) {
        lines.push(...renderTreeWithPuids(result.children, ''));
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/** Recursively render a directory tree with box-drawing characters and d-puids. */
function renderTreeWithPuids(
  nodes: DirectoryResult['children'],
  prefix: string,
): string[] {
  const lines: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const connector = isLast ? '\u2514\u2500' : '\u251C\u2500';
    const dirPuid = assignDirPuid(node.path);
    const stats = `${node.fileCount} files \u00B7 ${node.subdirCount} subdirs`;
    lines.push(`${prefix}${connector} ${dirPuid}: ${node.name}/ (${stats})`);

    if (node.children.length > 0) {
      const childPrefix = prefix + (isLast ? '   ' : '\u2502  ');
      lines.push(...renderTreeWithPuids(node.children, childPrefix));
    }
  }
  return lines;
}

// ── Tool Descriptions ────────────────────────────────────────────────────────

const SEARCH_DESCRIPTION = [
  'Search across locally indexed files using semantic (vector) search.',
  'Returns ranked file results with relevant code/text chunks.',
  '',
  'Results are scored on two axes:',
  '  \u2022 content \u2014 max(semantic similarity, BM25 keyword match) per chunk',
  '  \u2022 filename \u2014 Levenshtein similarity of the query to the file name',
  'The file score is max(content, filename), making all scores transparent [0,1].',
  '',
  'Each result is assigned a short reference ID (r1, r2, ...) for use with lodestone_read.',
  'Reference IDs persist across all tool calls in the session (never reset).',
  'Use lodestone_read after searching to retrieve full file contents.',
  '',
  'Use the lodestone_status tool to see available silos and their current state.',
].join('\n');

const READ_DESCRIPTION = [
  'Read file contents by reference ID from a previous lodestone_search or lodestone_explore.',
  'Supports text and image files (PNG, JPG, GIF, WebP, SVG).',
  '',
  'Accepts an array of references:',
  '  \u2022 Plain string "r1" \u2014 reads the full file for result r1',
  '  \u2022 Object { id: "r1", startLine: 10, endLine: 20 } \u2014 reads lines 10\u201320',
  '',
  'Reference IDs (r1, r2, ...) persist across all tool calls in the session.',
  'You can also pass absolute file paths instead of reference IDs.',
  '',
  'Note: d-prefixed IDs (d1, d2, ...) are directory references from lodestone_explore.',
  'They cannot be read \u2014 use lodestone_explore with startPath to browse directories.',
  '',
  'Examples:',
  '  \u2022 ["r1", "r3"] \u2014 read two files from the last search',
  '  \u2022 [{ id: "r2", startLine: 10, endLine: 50 }] \u2014 read a specific line range',
  '  \u2022 ["C:/Users/me/docs/notes.md"] \u2014 read a file directly by path (no search needed)',
].join('\n');

const EXPLORE_DESCRIPTION = [
  'Explore the directory structure of locally indexed silos.',
  'Returns ranked directories with nested tree views showing file/subdirectory counts.',
  '',
  'Each directory is assigned a short reference ID (d1, d2, ...) for use with other tools.',
  'Reference IDs persist across all tool calls in the session (never reset).',
  '',
  'Use lodestone_explore without startPath for a structural overview (compact, no file listing).',
  'Use lodestone_explore with startPath to drill into a directory \u2014 fullContents defaults to true,',
  'listing every file (with r-prefixed IDs for lodestone_read) and subdirectory.',
  '',
  'Directories are scored on two axes:',
  '  \u2022 segment \u2014 Levenshtein similarity of query to directory name (finds dirs by name)',
  '  \u2022 keyword \u2014 token coverage of query words in directory name (finds dirs matching multi-word queries)',
  '',
  'Typical workflow:',
  '  1. lodestone_explore (no args) \u2192 see top-level directories with d-IDs',
  '  2. lodestone_explore startPath: "d3" \u2192 drill in, see files with r-IDs',
  '  3. lodestone_read ["r5", "r8"] \u2192 read files of interest',
  '  4. lodestone_explore startPath: parent d-ID \u2192 navigate back up',
  '',
  'Use the lodestone_status tool to see available silos and their current state.',
].join('\n');

const EDIT_DESCRIPTION = [
  'Edit files within indexed silos. Seven operations:',
  '',
  'Text editing (requires file parameter):',
  '  \u2022 str_replace \u2014 Replace a unique string (must match exactly once)',
  '  \u2022 insert_at_line \u2014 Insert content before a specific line number',
  '  \u2022 overwrite \u2014 Replace entire file content',
  '  \u2022 append \u2014 Add content to end of file',
  '',
  'File lifecycle:',
  '  \u2022 create \u2014 Create a new file (returns a puid for immediate use)',
  '  \u2022 move \u2014 Move or rename a file (supports dry_run)',
  '  \u2022 delete \u2014 Move a file to OS trash (recoverable, supports dry_run)',
  '',
  'All operations accept puid references (e.g. "r3", "d5") from lodestone_search/explore/read,',
  'or absolute file paths. All mutating operations support dry_run for previewing changes.',
  '',
  'Staleness detection: If a file was previously read via lodestone_read and has been',
  'modified externally since, the edit is rejected with the current file content.',
  'This prevents accidental overwrites of concurrent changes.',
  '',
  'Files must be within a configured silo directory. Text edits require valid UTF-8.',
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
      startPath: z.string().optional().describe('Filter results to files under this directory path. Accepts d-prefixed reference IDs (e.g. "d3") from lodestone_explore.'),
    },
    async ({ query, silo, maxResults, startPath }) => {
      try {
        // Resolve d-prefixed puids in startPath to absolute paths
        let resolvedStartPath = startPath;
        if (startPath && isDirPuid(startPath)) {
          const resolved = resolvePuid(startPath);
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

  // ── Register lodestone_read tool ──

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
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];

        for (const entry of refs) {
          const id = typeof entry === 'string' ? entry : entry.id;
          const startLine = typeof entry === 'object' ? entry.startLine : undefined;
          const endLine = typeof entry === 'object' ? entry.endLine : undefined;

          // Reject directory puids — direct the LLM to use lodestone_explore
          if (isDirPuid(id)) {
            const dirPath = resolvePuid(id);
            content.push({
              type: 'text' as const,
              text: `## ${id}: ${dirPath}\nError: "${id}" is a directory reference. Use lodestone_explore with startPath: "${id}" to browse its contents.`,
            });
            continue;
          }

          // Check for invalidated puids (moved or deleted files)
          if (/^r\d+$/.test(id)) {
            const resolved = resolvePuidRecord(id);
            if (resolved && 'error' in resolved) {
              content.push({ type: 'text' as const, text: `## ${id}\nError: ${resolved.error}` });
              continue;
            }
          }

          const filePath = resolvePuid(id);
          const record = puidMap.get(id); // may be undefined for raw-path reads
          const mime = imageMimeType(filePath);

          try {
            if (mime) {
              // Image file — return as base64 image content block
              const buf = fs.readFileSync(filePath);
              content.push({ type: 'text' as const, text: `## ${id}: ${filePath}` });
              content.push({ type: 'image' as const, data: buf.toString('base64'), mimeType: mime });
            } else {
              // Text file — return as text content block
              const text = fs.readFileSync(filePath, 'utf-8');

              // Lazily compute and cache the content hash on first read
              if (record && !record.contentHash) {
                record.contentHash = computeFileHash(filePath);
              }

              if (startLine || endLine) {
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
        // Resolve d-prefixed puids in startPath to absolute paths
        let resolvedStartPath = startPath;
        if (startPath && isDirPuid(startPath)) {
          const resolved = resolvePuid(startPath);
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

        let text = formatExploreResults(results, effectiveFullContents);

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

  // ── Register lodestone_edit tool ──

  server.tool(
    'lodestone_edit',
    EDIT_DESCRIPTION,
    {
      operation: z.enum(['str_replace', 'insert_at_line', 'overwrite', 'append', 'create', 'move', 'delete']).describe('The edit operation to perform'),
      file: z.string().optional().describe('Puid (e.g. "r3") or absolute filepath. Required for str_replace, insert_at_line, overwrite, append, move, delete.'),
      old_str: z.string().optional().describe('String to find and replace (must match exactly once). Required for str_replace.'),
      new_str: z.string().optional().describe('Replacement string. Required for str_replace.'),
      line: z.number().int().min(1).optional().describe('1-based line number to insert before. Required for insert_at_line.'),
      content: z.string().optional().describe('Content to insert/write/append/create. Required for insert_at_line, overwrite, append, create.'),
      dry_run: z.boolean().optional().describe('Preview the change without writing to disk.'),
      context_lines: z.number().int().min(0).optional().describe('Lines of surrounding context in confirmation (default: from config).'),
      full_document: z.boolean().optional().describe('Return the full document after edit instead of a context snippet.'),
      directory: z.string().optional().describe('D-puid (e.g. "d5") or absolute directory path. Required for create.'),
      filename: z.string().optional().describe('Name of the file to create. Required for create.'),
      destination: z.string().optional().describe('D-puid, absolute directory path, or absolute filepath. Required for move.'),
      destination_type: z.enum(['directory', 'filepath']).optional().describe('Whether destination is a directory (preserve filename) or a filepath (rename). Required for move.'),
    },
    async ({ operation, file, old_str, new_str, line, content, dry_run, context_lines, full_document, directory, filename, destination, destination_type }) => {
      try {
        // ── Collect silo directories (needed by all operations) ──
        const statusResult = await deps.status();
        const siloDirectories = statusResult.silos.flatMap(s => s.config.directories);

        // ── CREATE ──
        if (operation === 'create') {
          if (directory === undefined || filename === undefined || content === undefined) {
            return { content: [{ type: 'text' as const, text: 'Error: create requires directory, filename, and content parameters.' }], isError: true };
          }

          // Resolve d-puid
          let resolvedDir = directory;
          if (isDirPuid(directory)) {
            const resolved = resolvePuidRecord(directory);
            if (!resolved) {
              return { content: [{ type: 'text' as const, text: `Error: Unknown directory reference "${directory}". It may be from a previous session.` }], isError: true };
            }
            if ('error' in resolved) {
              return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true };
            }
            resolvedDir = resolved.filepath;
          }

          const result = await deps.edit({
            operation: { op: 'create', directory: resolvedDir, filename, content, fullDocument: full_document },
            contextLines: 0,
            siloDirectories,
          });

          if (!result.success) {
            return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
          }

          // Assign puid for the new file and cache the hash
          const newFilePath = result.sourcePath!;
          const newPuid = assignFilePuid(newFilePath);
          const newRecord = puidMap.get(newPuid)!;
          newRecord.contentHash = result.newHash;

          // Format response
          const parts: string[] = [`Created ${newPuid}: ${newFilePath}`];
          if (result.fullContent) {
            parts.push('');
            parts.push(result.fullContent);
          }
          return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
        }

        // ── MOVE ──
        if (operation === 'move') {
          if (file === undefined) {
            return { content: [{ type: 'text' as const, text: 'Error: move requires file parameter.' }], isError: true };
          }
          if (destination === undefined || destination_type === undefined) {
            return { content: [{ type: 'text' as const, text: 'Error: move requires destination and destination_type parameters.' }], isError: true };
          }

          // Resolve file reference
          let filePath: string;
          let puidKey: string | undefined;
          let puidRecord: PuidRecord | undefined;
          if (/^r\d+$/.test(file)) {
            const resolved = resolvePuidRecord(file);
            if (!resolved) {
              return { content: [{ type: 'text' as const, text: `Error: Unknown puid "${file}". It may be from a previous session.` }], isError: true };
            }
            if ('error' in resolved) {
              return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true };
            }
            puidKey = file;
            puidRecord = resolved;
            filePath = resolved.filepath;
          } else {
            filePath = file;
          }

          // Staleness check
          if (puidRecord?.contentHash) {
            const currentHash = computeFileHash(filePath);
            if (currentHash !== puidRecord.contentHash) {
              return {
                content: [{ type: 'text' as const, text: `File has been modified externally since last read.\nStored hash: ${puidRecord.contentHash}\nCurrent hash: ${currentHash}` }],
                isError: true,
              };
            }
          }

          // Resolve destination (d-puid or path)
          let resolvedDest = destination;
          if (isDirPuid(destination)) {
            const resolved = resolvePuidRecord(destination);
            if (!resolved) {
              return { content: [{ type: 'text' as const, text: `Error: Unknown directory reference "${destination}". It may be from a previous session.` }], isError: true };
            }
            if ('error' in resolved) {
              return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true };
            }
            resolvedDest = resolved.filepath;
          }

          const result = await deps.edit({
            operation: { op: 'move', filePath, destination: resolvedDest, destinationType: destination_type, dryRun: dry_run },
            contextLines: 0,
            siloDirectories,
          });

          if (!result.success) {
            return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
          }

          // Invalidate puids on live (non-dry-run) moves
          if (!dry_run) {
            if (puidKey) invalidatePuid(puidKey);
            invalidateByPath(filePath);
          }

          // Format response
          const parts: string[] = [];
          if (dry_run) {
            parts.push(`Dry run — file would be moved:`);
            parts.push(`  ${result.sourcePath} → ${result.destinationPath}`);
          } else {
            parts.push(`Moved: ${result.sourcePath} → ${result.destinationPath}`);
          }
          if (result.sourceDirectoryListing) {
            parts.push('');
            parts.push('Source directory:');
            parts.push(result.sourceDirectoryListing);
          }
          if (result.destinationDirectoryListing) {
            parts.push('');
            parts.push('Destination directory:');
            parts.push(result.destinationDirectoryListing);
          }
          return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
        }

        // ── DELETE ──
        if (operation === 'delete') {
          if (file === undefined) {
            return { content: [{ type: 'text' as const, text: 'Error: delete requires file parameter.' }], isError: true };
          }

          // Resolve file reference
          let filePath: string;
          let puidKey: string | undefined;
          let puidRecord: PuidRecord | undefined;
          if (/^r\d+$/.test(file)) {
            const resolved = resolvePuidRecord(file);
            if (!resolved) {
              return { content: [{ type: 'text' as const, text: `Error: Unknown puid "${file}". It may be from a previous session.` }], isError: true };
            }
            if ('error' in resolved) {
              return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true };
            }
            puidKey = file;
            puidRecord = resolved;
            filePath = resolved.filepath;
          } else {
            filePath = file;
          }

          // Staleness check
          if (puidRecord?.contentHash) {
            const currentHash = computeFileHash(filePath);
            if (currentHash !== puidRecord.contentHash) {
              return {
                content: [{ type: 'text' as const, text: `File has been modified externally since last read.\nStored hash: ${puidRecord.contentHash}\nCurrent hash: ${currentHash}` }],
                isError: true,
              };
            }
          }

          const result = await deps.edit({
            operation: { op: 'delete', filePath, dryRun: dry_run },
            contextLines: 0,
            siloDirectories,
          });

          if (!result.success) {
            return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
          }

          // Invalidate puids on live (non-dry-run) deletes
          if (!dry_run) {
            if (puidKey) invalidatePuid(puidKey);
            invalidateByPath(filePath);
          }

          // Format response
          const parts: string[] = [];
          if (dry_run) {
            parts.push(`Dry run — file would be moved to trash:`);
            parts.push(`  ${result.sourcePath}`);
          } else {
            parts.push(`Moved to trash: ${result.sourcePath}`);
            parts.push('');
            parts.push('The file can be recovered from the operating system trash/recycle bin.');
          }
          if (result.sourceDirectoryListing) {
            parts.push('');
            parts.push('Directory:');
            parts.push(result.sourceDirectoryListing);
          }
          return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
        }

        // ── TEXT EDITING OPERATIONS (str_replace, insert_at_line, overwrite, append) ──
        if (file === undefined) {
          return { content: [{ type: 'text' as const, text: `Error: ${operation} requires file parameter.` }], isError: true };
        }

        // 1. Resolve file reference
        let filePath: string;
        let puidRecord: PuidRecord | undefined;
        if (/^r\d+$/.test(file)) {
          const resolved = resolvePuidRecord(file);
          if (!resolved) {
            return {
              content: [{ type: 'text' as const, text: `Error: Unknown puid "${file}". It may be from a previous session. Search or explore again to get a fresh reference.` }],
              isError: true,
            };
          }
          if ('error' in resolved) {
            return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true };
          }
          puidRecord = resolved;
          filePath = resolved.filepath;
        } else {
          filePath = file;
        }

        // 2. Staleness check (puid path only — raw filepaths skip this)
        if (puidRecord?.contentHash) {
          const currentHash = computeFileHash(filePath);
          if (currentHash !== puidRecord.contentHash) {
            let body = `File has been modified externally since last read.\nStored hash: ${puidRecord.contentHash}\nCurrent hash: ${currentHash}`;
            try {
              const currentContent = fs.readFileSync(filePath, 'utf-8');
              body += `\n\nCurrent content:\n\`\`\`\n${currentContent}\n\`\`\``;
            } catch { /* if read fails, just show hashes */ }
            return {
              content: [{ type: 'text' as const, text: body }],
              isError: true,
            };
          }
        }

        // 3. Resolve context_lines default
        const defaults = await deps.getDefaults();
        const effectiveContextLines = context_lines ?? defaults.contextLines;

        // 4. Build operation and dispatch
        let editOp: import('./edit').EditOperation;
        switch (operation) {
          case 'str_replace':
            if (old_str === undefined || new_str === undefined) {
              return { content: [{ type: 'text' as const, text: 'Error: str_replace requires old_str and new_str parameters.' }], isError: true };
            }
            editOp = { op: 'str_replace', filePath, oldStr: old_str, newStr: new_str, dryRun: dry_run, contextLines: context_lines, fullDocument: full_document };
            break;
          case 'insert_at_line':
            if (line === undefined || content === undefined) {
              return { content: [{ type: 'text' as const, text: 'Error: insert_at_line requires line and content parameters.' }], isError: true };
            }
            editOp = { op: 'insert_at_line', filePath, line, content, dryRun: dry_run, contextLines: context_lines, fullDocument: full_document };
            break;
          case 'overwrite':
            if (content === undefined) {
              return { content: [{ type: 'text' as const, text: 'Error: overwrite requires content parameter.' }], isError: true };
            }
            editOp = { op: 'overwrite', filePath, content, dryRun: dry_run, contextLines: context_lines, fullDocument: full_document };
            break;
          case 'append':
            if (content === undefined) {
              return { content: [{ type: 'text' as const, text: 'Error: append requires content parameter.' }], isError: true };
            }
            editOp = { op: 'append', filePath, content, dryRun: dry_run, contextLines: context_lines, fullDocument: full_document };
            break;
        }

        const result = await deps.edit({
          operation: editOp,
          contextLines: effectiveContextLines,
          siloDirectories,
        });

        // 5. Update puid hash on success (non-dry-run)
        if (result.success && !dry_run && result.newHash && puidRecord) {
          puidRecord.contentHash = result.newHash;
        }

        // 6. Format response
        if (!result.success) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
            isError: true,
          };
        }

        const parts: string[] = [];
        if (result.diff) parts.push(result.diff);
        if (result.contextSnippet) {
          parts.push('Context:');
          parts.push(result.contextSnippet);
        }
        if (result.fullContent) {
          parts.push('Full document:');
          parts.push('```');
          parts.push(result.fullContent);
          parts.push('```');
        }
        if (parts.length === 0) parts.push('Edit applied successfully.');

        return {
          content: [{ type: 'text' as const, text: parts.join('\n') }],
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
