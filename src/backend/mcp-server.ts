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
import type { SearchResult, DirectoryResult, SiloStatus, MemoryRecord, MemorySearchResult } from '../shared/types';
import type { EditOperation, EditResult } from './edit';
import { tokenise } from './tokeniser';
import { parseFlexibleDate, parseRecurrence } from './date-parser';

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
    mode?: 'hybrid' | 'bm25' | 'semantic' | 'filepath' | 'regex';
    filePattern?: string;
    regexFlags?: string;
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
  /** Write or update a memory entry. */
  memoryRemember: (params: {
    topic: string;
    body: string;
    confidence?: number;
    contextHint?: string;
    force?: boolean;
    actionDate?: string | null;
    recurrence?: string | null;
    priority?: number | null;
  }) => Promise<
    | { status: 'created'; id: number }
    | { status: 'duplicate'; existing: MemoryRecord; similarity: number }
  >;
  /** Check if a memory database is currently connected. */
  isMemoryConnected?: () => boolean;
  /** Search memories using the decaying-sum signal pipeline. */
  memoryRecall: (params: {
    query: string;
    maxResults?: number;
    mode?: 'hybrid' | 'semantic' | 'bm25';
    updatedAfter?: string;
    updatedBefore?: string;
    actionAfter?: string;
    actionBefore?: string;
  }) => Promise<MemorySearchResult[]>;
  /** Explicitly update a memory by id. */
  memoryRevise: (params: {
    id: number;
    body?: string;
    confidence?: number;
    contextHint?: string | null;
    actionDate?: string | null;
    recurrence?: string | null;
    priority?: number | null;
    topic?: string;
  }) => Promise<void>;
  /** Delete a memory by id. */
  memoryForget: (params: { id: number }) => Promise<void>;
  /** Return N most recently updated memories. */
  memoryOrient: (params: { maxResults?: number }) => Promise<MemoryRecord[]>;
  /** Fetch a single memory record by id (for lodestone_read of m-puids). */
  memoryGetById: (params: { id: number }) => Promise<MemoryRecord | null>;
  /** Fire-and-forget notification to the GUI to trigger the shimmer on a card. */
  notifyActivity?: (params: { channel: 'silo' | 'memory'; siloName?: string }) => void;
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

/** Invalidate all puids whose paths fall under a directory (prefix-scan for directory move/delete). */
function invalidateByPathPrefix(dirPath: string): void {
  const resolved = path.resolve(dirPath);
  const prefix = resolved + path.sep;
  for (const [, record] of puidMap) {
    if (!record.invalidated) {
      const rp = path.resolve(record.filepath);
      if (rp === resolved || rp.startsWith(prefix)) {
        record.invalidated = true;
        record.invalidatedPath = record.filepath;
      }
    }
  }
  // Clean reverse lookups
  for (const [fp] of filePathToPuid) {
    const rp = path.resolve(fp);
    if (rp === resolved || rp.startsWith(prefix)) filePathToPuid.delete(fp);
  }
  for (const [dp] of dirPathToPuid) {
    const rp = path.resolve(dp);
    if (rp === resolved || rp.startsWith(prefix)) dirPathToPuid.delete(dp);
  }
}

function isDirPuid(id: string): boolean {
  return /^d\d+$/.test(id);
}

function isMemoryPuid(id: string): boolean {
  return /^m\d+$/.test(id);
}

/** Extract the memory DB primary key from an m-prefixed puid (e.g. "m5" → 5). */
function parseMemoryId(id: string): number {
  return parseInt(id.slice(1), 10);
}

/** Resolve a memory id parameter that may be a number or m-prefixed string. */
function resolveMemoryIdParam(id: number | string): number {
  if (typeof id === 'number') return id;
  if (isMemoryPuid(id)) return parseMemoryId(id);
  throw new Error(`Invalid memory id "${id}". Expected a number or m-prefixed id (e.g. "m5").`);
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

/** Return the MIME type if the file is an image, or null for text files. */
function imageMimeType(filePath: string): string | null {
  return IMAGE_MIME[path.extname(filePath).toLowerCase()] ?? null;
}

// ── Memory truncation ────────────────────────────────────────────────────────

/** Maximum characters to show in memory previews before truncating. */
const MEMORY_PREVIEW_CHARS = 200;

/** Truncate a memory body for preview, appending ellipsis if needed. */
function truncateMemoryBody(body: string, limit: number = MEMORY_PREVIEW_CHARS): string {
  if (body.length <= limit) return body;
  return body.slice(0, limit) + '\u2026';
}

/** Token threshold above which a body length warning is emitted. */
const MEMORY_BODY_WARN_TOKENS = 200;

/** Return a warning string if the memory body exceeds the token threshold, otherwise empty. */
function memoryBodyWarning(body: string): string {
  const count = tokenise(body).length;
  if (count <= MEMORY_BODY_WARN_TOKENS) return '';
  return `\n\n\u26a0\ufe0f This memory is ${count} tokens \u2014 consider splitting into smaller, atomic memories that reference each other by m-id for better search precision.`;
}

/** Map priority number to human-readable label. */
function priorityLabel(p: number): string {
  switch (p) {
    case 1: return 'low';
    case 2: return 'medium';
    case 3: return 'high';
    case 4: return 'critical';
    default: return String(p);
  }
}

// ── Read safety ──────────────────────────────────────────────────────────────

/** Maximum file size in bytes for full reads via lodestone_read. */
const MAX_READ_BYTES = 512 * 1024; // 512 KB

/** Number of preview lines to show when a file exceeds the read limit. */
const PREVIEW_LINES = 100;

// ── Memory nudge ─────────────────────────────────────────────────────────────

/** Gentle reminder appended to successful tool responses to encourage memory use. */
const MEMORY_NUDGE = '\n\n---\n\ud83d\udca1 If you\'ve learned something new or made a decision, consider saving it with lodestone_remember.';

/** Return the memory nudge if memory is connected, otherwise empty string. */
function memoryNudge(deps: McpServerDeps): string {
  return deps.isMemoryConnected?.() ? MEMORY_NUDGE : '';
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

    // Build score parenthetical — show signal name or convergence breakdown
    let scoreDetail: string;
    if (result.scoreLabel === 'convergence') {
      const parts = Object.entries(result.signals)
        .sort(([, a], [, b]) => b - a)
        .map(([name, s]) => `${name} ${Math.round(s * 100)}%`);
      scoreDetail = `convergence: ${parts.join(', ')}`;
    } else {
      scoreDetail = result.scoreLabel;
    }

    lines.push(`Silo: ${result.siloName} | Score: ${pct}% (${scoreDetail})`);

    // Hint line — show line range and section path if available
    if (result.hint) {
      const section = result.hint.sectionPath && result.hint.sectionPath.length > 0
        ? ` \u2014 "${result.hint.sectionPath.join(' > ')}"`
        : '';
      lines.push(`Hint: Lines ${result.hint.startLine}\u2013${result.hint.endLine}${section}`);
    }

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
    const dirScorerLabel = result.axes[result.scoreSource]?.bestSignal ?? result.scoreSource;
    lines.push(`Silo: ${result.siloName} | Score: ${pct}% (${result.scoreSource}, ${dirScorerLabel}) | ${result.fileCount} files \u00B7 ${result.subdirCount} subdirs`);
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
  'Note: m-prefixed IDs (m1, m2, ...) are memory references from lodestone_recall or lodestone_orient.',
  'Use lodestone_read with an m-puid to retrieve the full memory body when the preview is truncated.',
  '',
  'Examples:',
  '  \u2022 ["r1", "r3"] \u2014 read two files from the last search',
  '  \u2022 [{ id: "r2", startLine: 10, endLine: 50 }] \u2014 read a specific line range',
  '  \u2022 ["m5", "r3"] \u2014 read memory m5 and file r3',
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
  'Edit files within indexed silos. Nine operations:',
  '',
  'Text editing (requires target parameter):',
  '  \u2022 str_replace \u2014 Replace a unique string (must match exactly once)',
  '  \u2022 insert_at_line \u2014 Insert content before a specific line number',
  '  \u2022 overwrite \u2014 Replace entire file content',
  '  \u2022 append \u2014 Add content to end of file',
  '',
  'File lifecycle:',
  '  \u2022 create \u2014 Create a new file (returns a puid for immediate use)',
  '  \u2022 mkdir \u2014 Create a new directory (returns a d-puid for immediate use)',
  '  \u2022 rename \u2014 Rename a file or directory in place (fails if name already taken)',
  '  \u2022 move \u2014 Move or rename a file or directory (supports dry_run and on_conflict)',
  '  \u2022 delete \u2014 Move a file or directory to OS trash (recoverable, supports dry_run)',
  '',
  'All operations accept puid references (e.g. "r3", "d5") from lodestone_search/explore/read,',
  'or absolute file paths. All mutating operations support dry_run for previewing changes.',
  '',
  'Batch mode: move and delete accept target as an array of puids/paths to operate on',
  'multiple targets in a single call. Each element is processed independently; failures',
  'do not abort the batch. Text operations do not support batch mode.',
  '',
  'Conflict handling for move: use on_conflict to control behaviour when the destination',
  'already exists. "error" (default) rejects with [CONFLICT], "skip" silently skips with',
  '[SKIP], "overwrite" replaces the destination file with [OVERWRITE]. on_conflict only',
  'applies to file targets; directory conflicts always error. Dry-run detects conflicts',
  'and flags them in the response.',
  '',
  'Staleness detection: If a file was previously read via lodestone_read and has been',
  'modified externally since, the edit is rejected with the current file content.',
  'The stored hash is refreshed on conflict, so you can adjust and retry immediately',
  'without a separate lodestone_read call.',
  '',
  'Memory references (m-prefixed IDs) are supported for str_replace, overwrite, append, and delete',
  'operations. These route to memory-specific update/delete logic (lodestone_revise / lodestone_forget).',
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
      mode: z.enum(['hybrid', 'bm25', 'semantic', 'filepath', 'regex']).optional().describe('Search mode: hybrid (default, vector + BM25 + Levenshtein filename), bm25 (keyword-only), semantic (vector-only), filepath (filename/path matching only), or regex (full-table scan with JS RegExp)'),
      filePattern: z.string().optional().describe('Glob pattern to filter results to matching file paths (e.g. "**/*.ts")'),
      regexFlags: z.string().optional().describe('JavaScript regex flags for regex mode (default: "i")'),
    },
    async ({ query, silo, maxResults, startPath, mode, filePattern, regexFlags }) => {
      try {
        deps.notifyActivity?.({ channel: 'silo', siloName: silo });
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
          mode,
          filePattern,
          regexFlags,
        });

        let text = formatSearchResults(results);

        // Prepend readiness warnings so the caller knows about partial results
        if (warnings.length > 0) {
          const warningBlock = warnings.map((w) => `> ${w}`).join('\n');
          text = `${warningBlock}\n\n${text}`;
        }

        // Memory sidebar: append top 5 memory matches for supported modes
        const sidebarModes = new Set(['hybrid', 'bm25', 'semantic', undefined]);
        if (deps.isMemoryConnected?.() && sidebarModes.has(mode)) {
          try {
            const memories = await deps.memoryRecall({ query, maxResults: 5 });
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
        deps.notifyActivity?.({ channel: 'silo' });
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];

        for (const entry of refs) {
          const id = typeof entry === 'string' ? entry : entry.id;
          const startLine = typeof entry === 'object' ? entry.startLine : undefined;
          const endLine = typeof entry === 'object' ? entry.endLine : undefined;

          // Resolve memory puids — fetch full body from memory database
          if (isMemoryPuid(id)) {
            const memId = parseMemoryId(id);
            try {
              const memory = await deps.memoryGetById({ id: memId });
              if (!memory) {
                content.push({
                  type: 'text' as const,
                  text: `## ${id}\nError: Memory ${memId} not found. It may have been deleted.`,
                });
              } else {
                const memMeta = [`Confidence: ${memory.confidence}`, `Updated: ${memory.updatedAt}`];
                if (memory.actionDate) {
                  let actionStr = `Action: ${memory.actionDate}`;
                  if (memory.recurrence) actionStr += ` (${memory.recurrence})`;
                  memMeta.push(actionStr);
                }
                if (memory.priority) memMeta.push(`Priority: ${priorityLabel(memory.priority)}`);
                content.push({
                  type: 'text' as const,
                  text: [
                    `## ${id}: ${memory.topic}`,
                    memory.body,
                    '',
                    `_${memMeta.join(' | ')}_`,
                  ].join('\n'),
                });
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              content.push({ type: 'text' as const, text: `## ${id}\nError: ${msg}` });
            }
            continue;
          }

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
                record.contentHash = computeFileHash(filePath);
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
              // Text file — return as text content block
              const text = fs.readFileSync(filePath, 'utf-8');

              // Lazily compute and cache the content hash on first read
              if (record && !record.contentHash) {
                record.contentHash = computeFileHash(filePath);
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
        deps.notifyActivity?.({ channel: 'silo', siloName: silo });
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

  // ── Register lodestone_edit tool ──

  server.tool(
    'lodestone_edit',
    EDIT_DESCRIPTION,
    {
      operation: z.enum(['str_replace', 'insert_at_line', 'overwrite', 'append', 'create', 'mkdir', 'rename', 'move', 'delete']).describe('The edit operation to perform'),
      target: z.union([z.string(), z.array(z.string())]).optional().describe('Puid (e.g. "r3", "d5"), m-prefixed memory ID (e.g. "m5"), or absolute path. Required for str_replace, insert_at_line, overwrite, append, rename, move, delete. move and delete accept an array for batch operations.'),
      old_str: z.string().optional().describe('String to find and replace (must match exactly once). Required for str_replace.'),
      new_str: z.string().optional().describe('Replacement string. Required for str_replace.'),
      line: z.number().int().min(1).optional().describe('1-based line number to insert before. Required for insert_at_line.'),
      content: z.string().optional().describe('Content to insert/write/append/create. Required for insert_at_line, overwrite, append, create.'),
      dry_run: z.boolean().optional().describe('Preview the change without writing to disk.'),
      context_lines: z.number().int().min(0).optional().describe('Lines of surrounding context in confirmation (default: from config).'),
      full_document: z.boolean().optional().describe('Return the full document after edit instead of a context snippet.'),
      directory: z.string().optional().describe('D-puid (e.g. "d5") or absolute directory path. Required for create and mkdir.'),
      filename: z.string().optional().describe('Name of the file to create. Required for create.'),
      name: z.string().optional().describe('Name for mkdir (new directory) or rename (new name). Required for mkdir and rename.'),
      destination: z.string().optional().describe('D-puid, absolute directory path, or absolute filepath. Required for move.'),
      destination_type: z.enum(['directory', 'filepath']).optional().describe('Whether destination is a directory (preserve filename) or a filepath (rename). Required for move.'),
      on_conflict: z.enum(['error', 'skip', 'overwrite']).optional().describe('Conflict resolution for move when destination exists. "error" (default) rejects, "skip" silently skips, "overwrite" replaces. Only applies to file targets.'),
    },
    async ({ operation, target, old_str, new_str, line, content, dry_run, context_lines, full_document, directory, filename, name, destination, destination_type, on_conflict }) => {
      try {
        deps.notifyActivity?.({ channel: 'silo' });
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

        // ── MKDIR ──
        if (operation === 'mkdir') {
          if (directory === undefined || name === undefined) {
            return { content: [{ type: 'text' as const, text: 'Error: mkdir requires directory and name parameters.' }], isError: true };
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
            operation: { op: 'mkdir', directory: resolvedDir, name, dryRun: dry_run },
            contextLines: 0,
            siloDirectories,
          });

          if (!result.success) {
            return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
          }

          // Assign d-puid for the new directory
          const newDirPath = result.sourcePath!;
          if (!dry_run) {
            const newPuid = assignDirPuid(newDirPath);
            const parts: string[] = [`Created ${newPuid}: ${newDirPath}`];
            if (result.destinationDirectoryListing) {
              parts.push('');
              parts.push('Parent directory:');
              parts.push(result.destinationDirectoryListing);
            }
            return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
          } else {
            const parts: string[] = [`Dry run — directory would be created: ${newDirPath}`];
            if (result.destinationDirectoryListing) {
              parts.push('');
              parts.push('Parent directory:');
              parts.push(result.destinationDirectoryListing);
            }
            return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
          }
        }

        // ── RENAME ──
        if (operation === 'rename') {
          if (target === undefined || typeof target !== 'string') {
            return { content: [{ type: 'text' as const, text: 'Error: rename requires a single target parameter (not an array).' }], isError: true };
          }
          if (!name) {
            return { content: [{ type: 'text' as const, text: 'Error: rename requires name parameter.' }], isError: true };
          }

          // Resolve target reference (r-puid, d-puid, or raw path)
          let filePath: string;
          let puidKey: string | undefined;
          let puidRecord: PuidRecord | undefined;
          let isDirectory = false;

          if (/^r\d+$/.test(target)) {
            const resolved = resolvePuidRecord(target);
            if (!resolved) {
              return { content: [{ type: 'text' as const, text: `Error: Unknown puid "${target}". It may be from a previous session.` }], isError: true };
            }
            if ('error' in resolved) {
              return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true };
            }
            puidKey = target;
            puidRecord = resolved;
            filePath = resolved.filepath;
          } else if (isDirPuid(target)) {
            const resolved = resolvePuidRecord(target);
            if (!resolved) {
              return { content: [{ type: 'text' as const, text: `Error: Unknown directory reference "${target}". It may be from a previous session.` }], isError: true };
            }
            if ('error' in resolved) {
              return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true };
            }
            puidKey = target;
            puidRecord = resolved;
            filePath = resolved.filepath;
            isDirectory = true;
          } else {
            filePath = target;
            try { isDirectory = fs.statSync(filePath).isDirectory(); } catch { /* will fail in edit */ }
          }

          // Staleness check (files only)
          if (puidRecord?.contentHash) {
            const currentHash = computeFileHash(filePath);
            if (currentHash !== puidRecord.contentHash) {
              const fileContent = fs.readFileSync(filePath, 'utf-8');
              const msg = `File has been modified externally since last read. The edit has been rejected.\n\nStored hash: ${puidRecord.contentHash}\nCurrent hash: ${currentHash}\n\nCurrent file content:\n\`\`\`\n${fileContent}\n\`\`\``;
              puidRecord.contentHash = currentHash;
              return { content: [{ type: 'text' as const, text: msg }], isError: true };
            }
          }

          const result = await deps.edit({
            operation: { op: 'rename', target: filePath, name, dryRun: dry_run },
            contextLines: 0,
            siloDirectories,
          });

          if (!result.success) {
            return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
          }

          // Invalidate old puids and assign new ones on live (non-dry-run) renames
          if (!dry_run) {
            if (puidKey) invalidatePuid(puidKey);
            if (isDirectory) {
              invalidateByPathPrefix(filePath);
            } else {
              invalidateByPath(filePath);
            }

            // Assign new puid at the new path
            const newPath = result.destinationPath!;
            const parts: string[] = [];
            if (isDirectory) {
              const newPuid = assignDirPuid(newPath);
              parts.push(`Renamed ${newPuid}: ${result.sourcePath} → ${newPath}`);
            } else {
              const newPuid = assignFilePuid(newPath);
              parts.push(`Renamed ${newPuid}: ${result.sourcePath} → ${newPath}`);
            }
            if (result.sourceDirectoryListing) {
              parts.push('');
              parts.push('Directory:');
              parts.push(result.sourceDirectoryListing);
            }
            return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
          } else {
            const parts: string[] = [`Dry run — would rename:`];
            parts.push(`  ${result.sourcePath} → ${result.destinationPath}`);
            if (result.sourceDirectoryListing) {
              parts.push('');
              parts.push('Directory:');
              parts.push(result.sourceDirectoryListing);
            }
            return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
          }
        }

        // ── MOVE ──
        if (operation === 'move') {
          if (target === undefined) {
            return { content: [{ type: 'text' as const, text: 'Error: move requires target parameter.' }], isError: true };
          }
          if (destination === undefined || destination_type === undefined) {
            return { content: [{ type: 'text' as const, text: 'Error: move requires destination and destination_type parameters.' }], isError: true };
          }

          // Batch mode is handled in the batch section below
          if (Array.isArray(target)) {
            // Resolve destination (d-puid or path) — shared across all batch elements
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

            const batchResults: { source: string; destination?: string; success: boolean; error?: string; conflict?: boolean; overwritten?: boolean; destListing?: string }[] = [];

            for (const element of target) {
              // Resolve each element
              let filePath: string;
              let puidKey: string | undefined;
              let puidRecord: PuidRecord | undefined;
              let isDirectory = false;

              if (/^r\d+$/.test(element)) {
                const resolved = resolvePuidRecord(element);
                if (!resolved) { batchResults.push({ source: element, success: false, error: `Unknown puid "${element}"` }); continue; }
                if ('error' in resolved) { batchResults.push({ source: element, success: false, error: resolved.error }); continue; }
                puidKey = element;
                puidRecord = resolved;
                filePath = resolved.filepath;
              } else if (isDirPuid(element)) {
                const resolved = resolvePuidRecord(element);
                if (!resolved) { batchResults.push({ source: element, success: false, error: `Unknown directory reference "${element}"` }); continue; }
                if ('error' in resolved) { batchResults.push({ source: element, success: false, error: resolved.error }); continue; }
                puidKey = element;
                puidRecord = resolved;
                filePath = resolved.filepath;
                isDirectory = true;
              } else {
                filePath = element;
                try { isDirectory = fs.statSync(filePath).isDirectory(); } catch { /* will fail in edit */ }
              }

              // Staleness check (files only)
              if (puidRecord?.contentHash) {
                const currentHash = computeFileHash(filePath);
                if (currentHash !== puidRecord.contentHash) {
                  puidRecord.contentHash = currentHash;
                  batchResults.push({ source: filePath, success: false, error: 'File has been modified externally since last read.' });
                  continue;
                }
              }

              const result = await deps.edit({
                operation: { op: 'move', target: filePath, destination: resolvedDest, destinationType: destination_type, onConflict: on_conflict, dryRun: dry_run },
                contextLines: 0,
                siloDirectories,
              });

              if (!result.success) {
                batchResults.push({ source: filePath, success: false, error: result.error, conflict: result.conflict });
                continue;
              }

              batchResults.push({ source: filePath, destination: result.destinationPath, success: true, overwritten: result.overwritten, conflict: result.conflict, destListing: result.destinationDirectoryListing });

              // Invalidate puids on live (non-dry-run) moves
              if (!dry_run) {
                if (puidKey) invalidatePuid(puidKey);
                if (isDirectory) {
                  invalidateByPathPrefix(filePath);
                } else {
                  invalidateByPath(filePath);
                }
              }
            }

            // Format collapsed batch response
            const parts: string[] = [];

            for (const r of batchResults) {
              if (r.success && r.overwritten) {
                parts.push(`  [OVERWRITE] ${r.source} → ${r.destination}`);
              } else if (r.success && dry_run && r.conflict) {
                parts.push(`  [CONFLICT] ${r.source} → ${r.destination}`);
              } else if (r.success && dry_run) {
                parts.push(`  [WOULD MOVE] ${r.source} → ${r.destination}`);
              } else if (r.success) {
                parts.push(`  [OK] ${r.source} → ${r.destination}`);
              } else if (!r.success && r.conflict && on_conflict === 'skip') {
                parts.push(`  [SKIP] ${r.source}`);
              } else if (!r.success && r.conflict) {
                parts.push(`  [CONFLICT] ${r.source}: ${r.error}`);
              } else {
                parts.push(`  [FAIL] ${r.source}: ${r.error}`);
              }
            }

            // Single destination directory listing (collapsed format — from last successful move)
            const lastSuccess = [...batchResults].reverse().find(r => r.success && r.destListing);
            if (lastSuccess?.destListing) {
              parts.push('');
              parts.push('Destination directory:');
              parts.push(lastSuccess.destListing);
            }

            // Summary with separate counts
            const succeeded = batchResults.filter(r => r.success && !r.overwritten && !r.conflict).length;
            const overwritten = batchResults.filter(r => r.overwritten).length;
            const skipped = batchResults.filter(r => !r.success && r.conflict).length;
            const failed = batchResults.filter(r => !r.success && !r.conflict).length;
            const summaryParts: string[] = [`${succeeded + overwritten} of ${batchResults.length} succeeded`];
            if (overwritten > 0) summaryParts.push(`${overwritten} overwritten`);
            if (skipped > 0) summaryParts.push(`${skipped} ${on_conflict === 'skip' ? 'skipped' : 'conflicted'}`);
            if (failed > 0) summaryParts.push(`${failed} failed`);
            parts.push('');
            parts.push(summaryParts.join(', ') + '.');
            return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
          }

          // ── Single-target move ──

          // Resolve target reference (r-puid, d-puid, or raw path)
          let filePath: string;
          let puidKey: string | undefined;
          let puidRecord: PuidRecord | undefined;
          let isDirectory = false;
          if (/^r\d+$/.test(target)) {
            const resolved = resolvePuidRecord(target);
            if (!resolved) {
              return { content: [{ type: 'text' as const, text: `Error: Unknown puid "${target}". It may be from a previous session.` }], isError: true };
            }
            if ('error' in resolved) {
              return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true };
            }
            puidKey = target;
            puidRecord = resolved;
            filePath = resolved.filepath;
          } else if (isDirPuid(target)) {
            const resolved = resolvePuidRecord(target);
            if (!resolved) {
              return { content: [{ type: 'text' as const, text: `Error: Unknown directory reference "${target}". It may be from a previous session.` }], isError: true };
            }
            if ('error' in resolved) {
              return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true };
            }
            puidKey = target;
            puidRecord = resolved;
            filePath = resolved.filepath;
            isDirectory = true;
          } else {
            filePath = target;
            try { isDirectory = fs.statSync(filePath).isDirectory(); } catch { /* will fail in edit */ }
          }

          // Staleness check (files only — directories don't have content hashes)
          if (puidRecord?.contentHash) {
            const currentHash = computeFileHash(filePath);
            if (currentHash !== puidRecord.contentHash) {
              const body = `File has been modified externally since last read.\nStored hash: ${puidRecord.contentHash}\nCurrent hash: ${currentHash}`;
              puidRecord.contentHash = currentHash;
              return {
                content: [{ type: 'text' as const, text: body }],
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
            operation: { op: 'move', target: filePath, destination: resolvedDest, destinationType: destination_type, onConflict: on_conflict, dryRun: dry_run },
            contextLines: 0,
            siloDirectories,
          });

          if (!result.success) {
            if (result.conflict && on_conflict === 'skip') {
              return { content: [{ type: 'text' as const, text: `Skipped: file already exists at destination: ${result.destinationPath}` }] };
            }
            if (result.conflict) {
              return { content: [{ type: 'text' as const, text: `Conflict: ${result.error}` }], isError: true };
            }
            return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
          }

          // Invalidate puids on live (non-dry-run) moves
          if (!dry_run) {
            if (puidKey) invalidatePuid(puidKey);
            if (isDirectory) {
              invalidateByPathPrefix(filePath);
            } else {
              invalidateByPath(filePath);
            }
          }

          // Format response
          const parts: string[] = [];
          if (dry_run && result.conflict) {
            parts.push(`Dry run — would be moved (CONFLICT — destination exists):`);
            parts.push(`  ${result.sourcePath} → ${result.destinationPath}`);
          } else if (dry_run) {
            parts.push(`Dry run — would be moved:`);
            parts.push(`  ${result.sourcePath} → ${result.destinationPath}`);
          } else if (result.overwritten) {
            parts.push(`Moved (overwritten): ${result.sourcePath} → ${result.destinationPath}`);
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
          if (target === undefined) {
            return { content: [{ type: 'text' as const, text: 'Error: delete requires target parameter.' }], isError: true };
          }

          // Batch mode
          if (Array.isArray(target)) {
            const batchResults: { source: string; success: boolean; error?: string }[] = [];

            for (const element of target) {
              // Memory delete in batch mode
              if (isMemoryPuid(element)) {
                const memId = parseMemoryId(element);
                try {
                  if (dry_run) {
                    batchResults.push({ source: element, success: true });
                  } else {
                    await deps.memoryForget({ id: memId });
                    batchResults.push({ source: element, success: true });
                  }
                } catch (err) {
                  batchResults.push({ source: element, success: false, error: err instanceof Error ? err.message : String(err) });
                }
                continue;
              }

              let filePath: string;
              let puidKey: string | undefined;
              let puidRecord: PuidRecord | undefined;
              let isDirectory = false;

              if (/^r\d+$/.test(element)) {
                const resolved = resolvePuidRecord(element);
                if (!resolved) { batchResults.push({ source: element, success: false, error: `Unknown puid "${element}"` }); continue; }
                if ('error' in resolved) { batchResults.push({ source: element, success: false, error: resolved.error }); continue; }
                puidKey = element;
                puidRecord = resolved;
                filePath = resolved.filepath;
              } else if (isDirPuid(element)) {
                const resolved = resolvePuidRecord(element);
                if (!resolved) { batchResults.push({ source: element, success: false, error: `Unknown directory reference "${element}"` }); continue; }
                if ('error' in resolved) { batchResults.push({ source: element, success: false, error: resolved.error }); continue; }
                puidKey = element;
                puidRecord = resolved;
                filePath = resolved.filepath;
                isDirectory = true;
              } else {
                filePath = element;
                try { isDirectory = fs.statSync(filePath).isDirectory(); } catch { /* will fail in edit */ }
              }

              // Staleness check (files only)
              if (puidRecord?.contentHash) {
                const currentHash = computeFileHash(filePath);
                if (currentHash !== puidRecord.contentHash) {
                  puidRecord.contentHash = currentHash;
                  batchResults.push({ source: filePath, success: false, error: 'File has been modified externally since last read.' });
                  continue;
                }
              }

              const result = await deps.edit({
                operation: { op: 'delete', target: filePath, dryRun: dry_run },
                contextLines: 0,
                siloDirectories,
              });

              if (!result.success) {
                batchResults.push({ source: filePath, success: false, error: result.error });
                continue;
              }

              batchResults.push({ source: filePath, success: true });

              if (!dry_run) {
                if (puidKey) invalidatePuid(puidKey);
                if (isDirectory) {
                  invalidateByPathPrefix(filePath);
                } else {
                  invalidateByPath(filePath);
                }
              }
            }

            // Format batch response
            const parts: string[] = [];
            const succeeded = batchResults.filter(r => r.success).length;
            const failed = batchResults.length - succeeded;

            for (const r of batchResults) {
              if (r.success) {
                parts.push(dry_run ? `  [OK] ${r.source} would be trashed` : `  [OK] ${r.source}`);
              } else {
                parts.push(`  [FAIL] ${r.source}: ${r.error}`);
              }
            }

            parts.push('');
            parts.push(`${succeeded} of ${batchResults.length} operations succeeded${failed > 0 ? `, ${failed} failed` : ''}.`);
            return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
          }

          // ── Single-target delete ──

          // Memory delete (single target)
          if (isMemoryPuid(target)) {
            const memId = parseMemoryId(target);
            try {
              if (dry_run) {
                return { content: [{ type: 'text' as const, text: `Dry run — would delete memory m${memId}.` }] };
              }
              await deps.memoryForget({ id: memId });
              return { content: [{ type: 'text' as const, text: `Memory m${memId} deleted.` }] };
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
            }
          }

          let filePath: string;
          let puidKey: string | undefined;
          let puidRecord: PuidRecord | undefined;
          let isDirectory = false;
          if (/^r\d+$/.test(target)) {
            const resolved = resolvePuidRecord(target);
            if (!resolved) {
              return { content: [{ type: 'text' as const, text: `Error: Unknown puid "${target}". It may be from a previous session.` }], isError: true };
            }
            if ('error' in resolved) {
              return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true };
            }
            puidKey = target;
            puidRecord = resolved;
            filePath = resolved.filepath;
          } else if (isDirPuid(target)) {
            const resolved = resolvePuidRecord(target);
            if (!resolved) {
              return { content: [{ type: 'text' as const, text: `Error: Unknown directory reference "${target}". It may be from a previous session.` }], isError: true };
            }
            if ('error' in resolved) {
              return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true };
            }
            puidKey = target;
            puidRecord = resolved;
            filePath = resolved.filepath;
            isDirectory = true;
          } else {
            filePath = target;
            try { isDirectory = fs.statSync(filePath).isDirectory(); } catch { /* will fail in edit */ }
          }

          // Staleness check (files only — directories don't have content hashes)
          if (puidRecord?.contentHash) {
            const currentHash = computeFileHash(filePath);
            if (currentHash !== puidRecord.contentHash) {
              const body = `File has been modified externally since last read.\nStored hash: ${puidRecord.contentHash}\nCurrent hash: ${currentHash}`;
              puidRecord.contentHash = currentHash;
              return {
                content: [{ type: 'text' as const, text: body }],
                isError: true,
              };
            }
          }

          const result = await deps.edit({
            operation: { op: 'delete', target: filePath, dryRun: dry_run },
            contextLines: 0,
            siloDirectories,
          });

          if (!result.success) {
            return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
          }

          // Invalidate puids on live (non-dry-run) deletes
          if (!dry_run) {
            if (puidKey) invalidatePuid(puidKey);
            if (isDirectory) {
              invalidateByPathPrefix(filePath);
            } else {
              invalidateByPath(filePath);
            }
          }

          // Format response
          const parts: string[] = [];
          if (dry_run) {
            parts.push(`Dry run — would be moved to trash:`);
            parts.push(`  ${result.sourcePath}`);
          } else {
            parts.push(`Moved to trash: ${result.sourcePath}`);
            parts.push('');
            parts.push('Can be recovered from the operating system trash/recycle bin.');
          }
          if (result.sourceDirectoryListing) {
            parts.push('');
            parts.push('Directory:');
            parts.push(result.sourceDirectoryListing);
          }
          return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
        }

        // ── TEXT EDITING OPERATIONS (str_replace, insert_at_line, overwrite, append) ──
        if (target === undefined) {
          return { content: [{ type: 'text' as const, text: `Error: ${operation} requires target parameter.` }], isError: true };
        }
        if (Array.isArray(target)) {
          return { content: [{ type: 'text' as const, text: 'Error: Batch mode is only supported for move and delete operations.' }], isError: true };
        }

        // ── Memory routing: m-prefixed targets route to memory operations ──
        // (delete with m-ids is handled in the DELETE section above)
        if (isMemoryPuid(target)) {
          const memId = parseMemoryId(target);
          const supported = new Set(['str_replace', 'overwrite', 'append']);
          if (!supported.has(operation)) {
            return {
              content: [{ type: 'text' as const, text: `Error: Operation "${operation}" is not supported for memory references. Supported: str_replace, overwrite, append, delete.` }],
              isError: true,
            };
          }

          try {
            // For str_replace, overwrite, append — fetch current body, modify, revise
            const existing = await deps.memoryGetById({ id: memId });
            if (!existing) {
              return { content: [{ type: 'text' as const, text: `Error: Memory m${memId} not found. It may have been deleted.` }], isError: true };
            }

            let newBody: string;
            if (operation === 'overwrite') {
              if (content === undefined) {
                return { content: [{ type: 'text' as const, text: 'Error: overwrite requires content parameter.' }], isError: true };
              }
              newBody = content;
            } else if (operation === 'append') {
              if (content === undefined) {
                return { content: [{ type: 'text' as const, text: 'Error: append requires content parameter.' }], isError: true };
              }
              newBody = existing.body + content;
            } else {
              // str_replace
              if (old_str === undefined || new_str === undefined) {
                return { content: [{ type: 'text' as const, text: 'Error: str_replace requires old_str and new_str parameters.' }], isError: true };
              }
              const idx = existing.body.indexOf(old_str);
              if (idx === -1) {
                return { content: [{ type: 'text' as const, text: `Error: old_str not found in memory m${memId} body.` }], isError: true };
              }
              // Check uniqueness
              const secondIdx = existing.body.indexOf(old_str, idx + 1);
              if (secondIdx !== -1) {
                return { content: [{ type: 'text' as const, text: `Error: old_str matches multiple locations in memory m${memId}. Provide more context to make it unique.` }], isError: true };
              }
              newBody = existing.body.slice(0, idx) + new_str + existing.body.slice(idx + old_str.length);
            }

            if (dry_run) {
              const warning = memoryBodyWarning(newBody);
              return { content: [{ type: 'text' as const, text: `Dry run — memory m${memId} would be revised.\n\nNew body:\n${newBody}${warning}` }] };
            }

            await deps.memoryRevise({ id: memId, body: newBody });
            const warning = memoryBodyWarning(newBody);
            return { content: [{ type: 'text' as const, text: `Memory m${memId} revised via ${operation}.${warning}` }] };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
          }
        }

        // 1. Resolve file reference
        let filePath: string;
        let puidRecord: PuidRecord | undefined;
        if (/^r\d+$/.test(target)) {
          const resolved = resolvePuidRecord(target);
          if (!resolved) {
            return {
              content: [{ type: 'text' as const, text: `Error: Unknown puid "${target}". It may be from a previous session. Search or explore again to get a fresh reference.` }],
              isError: true,
            };
          }
          if ('error' in resolved) {
            return { content: [{ type: 'text' as const, text: `Error: ${resolved.error}` }], isError: true };
          }
          puidRecord = resolved;
          filePath = resolved.filepath;
        } else {
          filePath = target;
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
            puidRecord.contentHash = currentHash;
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
          content: [{ type: 'text' as const, text: parts.join('\n') + memoryNudge(deps) }],
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

  // ── Register memory tools ──

  server.tool(
    'lodestone_remember',
    [
      'Write a new memory or update an existing similar one.',
      '',
      'Before inserting, checks cosine similarity against existing memories.',
      'If a closely related entry is found, its details are returned so you can',
      'decide whether to update it (via lodestone_revise) or force-create a new one.',
      '',
      'Keep memories atomic — each should capture a single concept or decision.',
      'If a memory grows beyond ~200 tokens, consider splitting it into multiple',
      'memories that reference each other by m-id (e.g. "see m12 for the schema',
      'details"). Memory IDs are stable primary keys and safe to reference.',
      '',
      'Parameters:',
      '  topic        — Short label categorising the memory (e.g. "JAMES - THINKING STYLE")',
      '  body         — The memory content (plain text)',
      '  confidence   — Float 0–1. 1.0 = reliable, lower = tentative. Default: 1.0',
      '  context_hint — Optional short string recording the conversational context',
      '  force        — Skip dedup check and always create a new memory. Default: false',
      '  action_date  — Optional date for when this memory is actionable. Accepts flexible',
      '                  expressions ("tomorrow", "next Monday", "2026-03-15"). Stored as',
      '                  ISO 8601 (YYYY-MM-DD).',
      '  recurrence   — Optional recurrence rule for repeating action dates. Accepted formats:',
      '                  "daily", "weekly", "biweekly", "monthly", "yearly",',
      '                  "every monday", "every weekday", "every 3 days", "every 2 weeks".',
      '                  Requires action_date to be set. The action_date auto-advances on orient.',
      '  priority     — Optional urgency level: 1=low, 2=medium, 3=high, 4=critical.',
      '',
      'Returns: { id } on success, or details of a similar existing memory for review.',
    ].join('\n'),
    {
      topic: z.string().describe('Short label categorising the memory (e.g. "LODESTONE", "JAMES - THINKING STYLE")'),
      body: z.string().describe('The memory content'),
      confidence: z.number().min(0).max(1).optional().describe('Epistemic confidence 0–1. Default: 1.0'),
      context_hint: z.string().optional().describe('Short string recording the conversational context (not searchable)'),
      force: z.boolean().optional().describe('Skip dedup check and always create a new memory. Default: false'),
      action_date: z.string().optional().describe('Date when this memory is actionable. Flexible expressions accepted ("tomorrow", "next Monday", "2026-03-15"). Stored as ISO 8601.'),
      recurrence: z.string().optional().describe('Recurrence rule: "daily", "weekly", "biweekly", "monthly", "yearly", "every monday", "every weekday", "every N days", "every N weeks". Requires action_date.'),
      priority: z.number().int().min(1).max(4).optional().describe('Urgency: 1=low, 2=medium, 3=high, 4=critical'),
    },
    async ({ topic, body, confidence, context_hint, force, action_date, recurrence, priority }) => {
      try {
        deps.notifyActivity?.({ channel: 'memory' });

        // Parse flexible action_date to ISO 8601
        let parsedActionDate: string | null = null;
        if (action_date) {
          parsedActionDate = parseFlexibleDate(action_date);
          if (!parsedActionDate) {
            return {
              content: [{ type: 'text' as const, text: `Error: Could not parse action_date "${action_date}". Use ISO 8601 (YYYY-MM-DD), relative expressions (tomorrow, next Monday), or natural dates (March 15).` }],
              isError: true,
            };
          }
        }

        // Parse and validate recurrence rule
        let parsedRecurrence: string | null = null;
        if (recurrence) {
          parsedRecurrence = parseRecurrence(recurrence);
          if (!parsedRecurrence) {
            return {
              content: [{ type: 'text' as const, text: `Error: Could not parse recurrence "${recurrence}". Accepted: daily, weekly, biweekly, monthly, yearly, every monday, every weekday, every N days, every N weeks.` }],
              isError: true,
            };
          }
          if (!parsedActionDate) {
            return {
              content: [{ type: 'text' as const, text: `Error: recurrence requires action_date to be set. Provide an action_date for the first occurrence.` }],
              isError: true,
            };
          }
        }

        const result = await deps.memoryRemember({
          topic,
          body,
          confidence,
          contextHint: context_hint,
          force,
          actionDate: parsedActionDate,
          recurrence: parsedRecurrence,
          priority: priority ?? null,
        });

        if (result.status === 'duplicate') {
          const sim = Math.round(result.similarity * 100);
          const preview = truncateMemoryBody(result.existing.body);
          const meta: string[] = [];
          if (result.existing.actionDate) {
            let actionStr = `Action: ${result.existing.actionDate}`;
            if (result.existing.recurrence) actionStr += ` (${result.existing.recurrence})`;
            meta.push(actionStr);
          }
          if (result.existing.priority) meta.push(`Priority: ${priorityLabel(result.existing.priority)}`);
          const lines = [
            `Similar memory found (${sim}% similarity):`,
            '',
            `## [m${result.existing.id}] ${result.existing.topic} (confidence: ${result.existing.confidence})`,
            preview,
            ...(meta.length > 0 ? [`_${meta.join(' | ')}_`] : []),
            '',
            'Consider:',
            `- Use lodestone_revise(id: "m${result.existing.id}", body: "...") to update the existing memory.`,
            '- Use lodestone_remember with force: true to create a new memory despite the similarity.',
          ];
          return {
            content: [{ type: 'text' as const, text: lines.join('\n') }],
          };
        }

        const warning = memoryBodyWarning(body);
        const extras: string[] = [];
        if (parsedActionDate) {
          let actionStr = `Action date: ${parsedActionDate}`;
          if (parsedRecurrence) actionStr += ` (${parsedRecurrence})`;
          extras.push(actionStr + '.');
        }
        if (priority) extras.push(`Priority: ${priorityLabel(priority)}.`);
        return {
          content: [{ type: 'text' as const, text: `Created memory m${result.id}.${extras.length ? ' ' + extras.join(' ') : ''}${warning}` }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );

  server.tool(
    'lodestone_recall',
    [
      'Hybrid search over memories: BM25 (FTS5) + cosine similarity, fused by weighted-max.',
      '',
      'Returns ranked memory records with m-prefixed id, topic, truncated body preview, confidence, and score.',
      'Use this when you have a specific question or topic to retrieve context for.',
      'Results show truncated previews. Use lodestone_read with the m-prefixed ID (e.g. "m3") to read the full body.',
      '',
      'Query with natural language — use concepts, short sentences, or brief descriptions',
      'of what you are looking for (e.g. "how does the search pipeline compose scores"',
      'not "decaying-sum"). Think about meaning, not keywords.',
      '',
      'Parameters:',
      '  query          — Natural language search query',
      '  max_results    — Maximum memories to return. Default: 5',
      '  mode           — Search mode: hybrid (default, vector + BM25), bm25 (keyword-only), semantic (vector-only)',
      '  updated_after  — Filter to memories with updated_at >= this date',
      '  updated_before — Filter to memories with updated_at <= this date',
      '  action_after   — Filter to memories with action_date >= this date',
      '  action_before  — Filter to memories with action_date <= this date',
      '',
      'Date filters accept flexible expressions ("today", "yesterday", "last Monday",',
      '"next Friday", "2026-03-15") which are normalised to ISO 8601 before querying.',
      'Combine freely: updated_after + action_before for memories updated recently with upcoming deadlines.',
    ].join('\n'),
    {
      query: z.string().describe('Search query — natural language, use concepts and short sentences not keywords'),
      max_results: z.number().min(1).max(50).optional().describe('Maximum results to return. Default: 5'),
      mode: z.enum(['hybrid', 'bm25', 'semantic']).optional()
        .describe('Search mode: hybrid (default, vector + BM25), bm25 (keyword-only), semantic (vector-only)'),
      updated_after: z.string().optional().describe('Filter: updated_at >= this date. Flexible expressions accepted.'),
      updated_before: z.string().optional().describe('Filter: updated_at <= this date. Flexible expressions accepted.'),
      action_after: z.string().optional().describe('Filter: action_date >= this date. Flexible expressions accepted.'),
      action_before: z.string().optional().describe('Filter: action_date <= this date. Flexible expressions accepted.'),
    },
    async ({ query, max_results, mode, updated_after, updated_before, action_after, action_before }) => {
      try {
        deps.notifyActivity?.({ channel: 'memory' });

        // Parse flexible date expressions to ISO 8601
        const dateFilters: Record<string, string> = {};
        for (const [key, raw] of Object.entries({ updatedAfter: updated_after, updatedBefore: updated_before, actionAfter: action_after, actionBefore: action_before })) {
          if (!raw) continue;
          const parsed = parseFlexibleDate(raw);
          if (!parsed) {
            return {
              content: [{ type: 'text' as const, text: `Error: Could not parse date filter "${raw}". Use ISO 8601 (YYYY-MM-DD), relative expressions (tomorrow, next Monday), or natural dates (March 15).` }],
              isError: true,
            };
          }
          dateFilters[key] = parsed;
        }

        const results = await deps.memoryRecall({
          query,
          maxResults: max_results,
          mode,
          ...dateFilters,
        });
        if (results.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No memories found.' }] };
        }
        const lines: string[] = [];
        for (const r of results) {
          const pct = Math.round(r.score * 100);
          // Show signal breakdown: "62% convergence: semantic 58%, bm25 45%"
          // or single-signal: "58% semantic"
          const signalEntries = Object.entries(r.signals);
          let scoreStr: string;
          if (signalEntries.length <= 1) {
            scoreStr = `${pct}% ${r.scoreLabel}`;
          } else {
            const breakdown = signalEntries
              .sort(([, a], [, b]) => b - a)
              .map(([name, val]) => `${name} ${Math.round(val * 100)}%`)
              .join(', ');
            scoreStr = `${pct}% ${r.scoreLabel}: ${breakdown}`;
          }
          lines.push(`## [m${r.id}] ${r.topic} (${scoreStr}, confidence: ${r.confidence})`);
          lines.push(truncateMemoryBody(r.body));
          const meta = [`Updated: ${r.updatedAt}`];
          if (r.actionDate) {
            let actionStr = `Action: ${r.actionDate}`;
            if (r.recurrence) actionStr += ` (${r.recurrence})`;
            meta.push(actionStr);
          }
          if (r.priority) meta.push(`Priority: ${priorityLabel(r.priority)}`);
          lines.push(`_${meta.join(' | ')}_`);
          lines.push('');
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );

  server.tool(
    'lodestone_revise',
    [
      'Explicitly update a specific memory by id.',
      '',
      'Use this when you have recalled a memory and want to correct or extend it with',
      'precision, bypassing the similarity-based upsert of lodestone_remember.',
      'Also use it to adjust confidence on an existing memory without rewriting the body.',
      '',
      'Parameters:',
      '  id           — Memory id (from lodestone_recall or lodestone_orient)',
      '  body         — New body text (optional)',
      '  confidence   — New confidence value 0–1 (optional)',
      '  context_hint — New context hint (optional, pass null to clear)',
      '  action_date  — New action date (optional, pass null to clear). Flexible expressions accepted.',
      '  recurrence   — New recurrence rule (optional, pass null to clear).',
      '                  Accepted: daily, weekly, biweekly, monthly, yearly,',
      '                  every monday, every weekday, every N days, every N weeks.',
      '  priority     — New priority (optional, pass null to clear). 1=low, 2=medium, 3=high, 4=critical.',
      '  topic        — New topic label (optional).',
    ].join('\n'),
    {
      id: z.union([z.number().int(), z.string()]).describe('Memory id to update (number or m-prefixed id like "m5")'),
      body: z.string().optional().describe('New body text'),
      confidence: z.number().min(0).max(1).optional().describe('New confidence value 0–1'),
      context_hint: z.union([z.string(), z.null()]).optional().describe('New context hint (null to clear)'),
      action_date: z.union([z.string(), z.null()]).optional().describe('New action date (null to clear). Flexible expressions accepted.'),
      recurrence: z.union([z.string(), z.null()]).optional().describe('New recurrence rule (null to clear). Accepted: daily, weekly, biweekly, monthly, yearly, every monday, every weekday, every N days, every N weeks.'),
      priority: z.union([z.number().int().min(1).max(4), z.null()]).optional().describe('New priority (null to clear). 1=low, 2=medium, 3=high, 4=critical.'),
      topic: z.string().optional().describe('New topic label'),
    },
    async ({ id: rawId, body, confidence, context_hint, action_date, recurrence, priority, topic }) => {
      try {
        deps.notifyActivity?.({ channel: 'memory' });
        const id = resolveMemoryIdParam(rawId);

        // Parse flexible action_date to ISO 8601 (null clears it)
        let parsedActionDate: string | null | undefined;
        if (action_date === null) {
          parsedActionDate = null; // explicitly clear
        } else if (action_date !== undefined) {
          parsedActionDate = parseFlexibleDate(action_date);
          if (!parsedActionDate) {
            return {
              content: [{ type: 'text' as const, text: `Error: Could not parse action_date "${action_date}". Use ISO 8601 (YYYY-MM-DD), relative expressions (tomorrow, next Monday), or natural dates (March 15).` }],
              isError: true,
            };
          }
        }

        // Parse recurrence rule (null clears it)
        let parsedRecurrence: string | null | undefined;
        if (recurrence === null) {
          parsedRecurrence = null; // explicitly clear
        } else if (recurrence !== undefined) {
          parsedRecurrence = parseRecurrence(recurrence);
          if (!parsedRecurrence) {
            return {
              content: [{ type: 'text' as const, text: `Error: Could not parse recurrence "${recurrence}". Accepted: daily, weekly, biweekly, monthly, yearly, every monday, every weekday, every N days, every N weeks.` }],
              isError: true,
            };
          }
        }

        await deps.memoryRevise({
          id,
          body,
          confidence,
          contextHint: context_hint,
          actionDate: parsedActionDate,
          recurrence: parsedRecurrence,
          priority,
          topic,
        });
        const warning = body ? memoryBodyWarning(body) : '';
        return { content: [{ type: 'text' as const, text: `Memory m${id} revised.${warning}` }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );

  server.tool(
    'lodestone_forget',
    [
      'Remove a specific memory by id.',
      '',
      'Use when something is definitively wrong, no longer relevant,',
      'or has been superseded by a revised memory.',
      '',
      'Parameters:',
      '  id — Memory id (from lodestone_recall or lodestone_orient)',
    ].join('\n'),
    {
      id: z.union([z.number().int(), z.string()]).describe('Memory id to delete (number or m-prefixed id like "m5")'),
    },
    async ({ id: rawId }) => {
      try {
        deps.notifyActivity?.({ channel: 'memory' });
        const id = resolveMemoryIdParam(rawId);
        await deps.memoryForget({ id });
        return { content: [{ type: 'text' as const, text: `Memory m${id} deleted.` }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );

  server.tool(
    'lodestone_orient',
    [
      'Return the N most recently updated memories, regardless of query.',
      '',
      'This is the orientation tool — call it at the start of a conversation,',
      'before there is enough context to form a meaningful recall query,',
      'to ground yourself in recent and active working context.',
      '',
      'Also surfaces memories with action dates in the next 7 days, so upcoming',
      'deadlines and planned actions are visible at conversation start.',
      'Recurring memories auto-advance their action_date when it falls behind today.',
      '',
      'Results show truncated previews. Use lodestone_read with the m-prefixed ID (e.g. "m3") to read the full body.',
      '',
      'Parameters:',
      '  max_results — Maximum memories to return. Default: 10',
    ].join('\n'),
    {
      max_results: z.number().min(1).max(50).optional().describe('Maximum memories to return. Default: 10'),
    },
    async ({ max_results }) => {
      try {
        deps.notifyActivity?.({ channel: 'memory' });
        const results = await deps.memoryOrient({ maxResults: max_results });
        if (results.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No memories stored yet.' }] };
        }
        const lines: string[] = [];
        for (const r of results) {
          lines.push(`## [m${r.id}] ${r.topic} (confidence: ${r.confidence})`);
          lines.push(truncateMemoryBody(r.body));
          const meta = [`Updated: ${r.updatedAt}`];
          if (r.actionDate) {
            let actionStr = `Action: ${r.actionDate}`;
            if (r.recurrence) actionStr += ` (${r.recurrence})`;
            meta.push(actionStr);
          }
          if (r.priority) meta.push(`Priority: ${priorityLabel(r.priority)}`);
          lines.push(`_${meta.join(' | ')}_`);
          lines.push('');
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
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
