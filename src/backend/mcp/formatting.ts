/**
 * Formatting helpers, constants, and tool descriptions for the MCP server.
 */

import path from 'node:path';
import type { SearchResult, DirectoryResult, LocationHint } from '../../shared/types';
import { tokenise } from '../tokeniser';
import type { McpServerDeps } from './types';
import type { PuidManager } from './puid-manager';

// ── Date context ─────────────────────────────────────────────────────────────

const FULL_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FULL_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDateFull(d: Date): string {
  return `${FULL_DAY_NAMES[d.getDay()]} ${d.getDate()} ${FULL_MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

function formatDateShort(d: Date): string {
  return `${FULL_DAY_NAMES[d.getDay()].slice(0, 3)} ${d.getDate()} ${SHORT_MONTH_NAMES[d.getMonth()]}`;
}

function formatTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Return a human-readable datetime string with timezone, e.g. "Monday 2 March 2026, 14:32 (Europe/London)". */
export function buildDatetime(): string {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${formatDateFull(now)}, ${formatTime(now)} (${tz})`;
}

/**
 * Build a compact date reference line to prepend to orient/agenda output.
 * Anchors the LLM on today's date, current time, and key relative offsets,
 * preventing errors when reasoning about "yesterday", "tomorrow", and overdue items.
 */
export function buildDateContext(): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `📅 Today: ${formatDateFull(today)}, ${formatTime(now)} (${tz}) | Yesterday: ${formatDateShort(yesterday)} | Tomorrow: ${formatDateShort(tomorrow)}`;
}

// ── Memory truncation ────────────────────────────────────────────────────────

/** Maximum characters to show in memory previews before truncating. */
export const MEMORY_PREVIEW_CHARS = 200;

/** Truncate a memory body for preview, appending ellipsis if needed. */
export function truncateMemoryBody(body: string, limit: number = MEMORY_PREVIEW_CHARS): string {
  if (body.length <= limit) return body;
  return body.slice(0, limit) + '\u2026';
}

/** Token threshold above which a body length warning is emitted. */
const MEMORY_BODY_WARN_TOKENS = 200;

/** Return a warning string if the memory body exceeds the token threshold, otherwise empty. */
export function memoryBodyWarning(body: string): string {
  const count = tokenise(body).length;
  if (count <= MEMORY_BODY_WARN_TOKENS) return '';
  return `\n\n\u26a0\ufe0f This memory is ${count} tokens \u2014 consider splitting into smaller, atomic memories that reference each other by m-id for better search precision.`;
}

/** Map priority number to human-readable label. */
export function priorityLabel(p: number): string {
  switch (p) {
    case 1: return 'low';
    case 2: return 'medium';
    case 3: return 'high';
    case 4: return 'critical';
    default: return String(p);
  }
}

/** Map status string to a display label. */
export function statusLabel(s: string): string {
  switch (s) {
    case 'open': return 'open';
    case 'completed': return 'completed \u2713';
    case 'cancelled': return 'cancelled';
    default: return s;
  }
}

// ── Cross-search threshold ───────────────────────────────────────────────────

/**
 * Minimum score [0,1] for a result to appear in a cross-type sidebar.
 * Applied to memory hits shown during silo search, and to silo note hits
 * shown during memory recall. Keeps sidebars signal-positive only.
 */
export const CROSS_SEARCH_THRESHOLD = 0.45;

// ── Read safety ──────────────────────────────────────────────────────────────

/** Maximum file size in bytes for full reads via lodestone_read. */
export const MAX_READ_BYTES = 512 * 1024; // 512 KB

/** Number of preview lines to show when a file exceeds the read limit. */
export const PREVIEW_LINES = 100;

// ── Memory nudge ─────────────────────────────────────────────────────────────

/** Gentle reminder appended to successful tool responses to encourage memory use. */
const MEMORY_NUDGE = '\n\n---\n\ud83d\udca1 If you\'ve learned something new or made a decision, consider saving it with lodestone_remember.';

/** Return the memory nudge if memory is connected, otherwise empty string. */
export function memoryNudge(deps: McpServerDeps): string {
  return deps.isMemoryConnected?.() ? MEMORY_NUDGE : '';
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** Format a byte count into a human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Strip trailing path separators for consistent map keys. */
function normaliseDirPath(p: string): string {
  return p.replace(/[\\/]+$/, '');
}

/** Get the normalised parent directory path, or null if at a root. */
export function getParentDirPath(dirPath: string): string | null {
  const normalized = normaliseDirPath(dirPath);
  const parent = path.dirname(normalized);
  if (parent === normalized || parent === '.') return null;
  return parent;
}

/**
 * Check if a sectionPath is just the filename — if so, it adds no information
 * and should be suppressed. PDF and plaintext chunkers set sectionPath to [filename].
 */
function isRedundantSection(sectionPath: string[] | undefined, filePath: string): boolean {
  if (!sectionPath || sectionPath.length === 0) return true;
  if (sectionPath.length === 1) {
    const filename = path.basename(filePath);
    return sectionPath[0] === filename;
  }
  return false;
}

/** Format a LocationHint union into a human-readable string. */
function formatLocationHint(hint: LocationHint): string {
  if (!hint) return '';
  switch (hint.type) {
    case 'lines': return `Lines ${hint.start}\u2013${hint.end}`;
    case 'page':  return `Page ${hint.page}`;
  }
}

/**
 * Format search results into a readable text block for the MCP tool response.
 *
 * Each result is prefixed with a puid (r1, r2, ...) for use with lodestone_read,
 * followed by the full absolute file path, silo name, and score breakdown.
 */
export function formatSearchResults(results: SearchResult[], puid: PuidManager): string {
  if (results.length === 0) {
    return 'No results found.';
  }

  const lines: string[] = [];

  for (const result of results) {
    const id = puid.assignFilePuid(result.filePath);
    lines.push(`## ${id}: ${result.filePath}`);
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

    // Hint line — show location and section path if available
    if (result.hint) {
      const locationStr = formatLocationHint(result.hint.locationHint ?? null);
      const section = isRedundantSection(result.hint.sectionPath, result.filePath)
        ? ''
        : `"${result.hint.sectionPath!.join(' > ')}"`;
      const parts = [locationStr, section].filter(Boolean);
      if (parts.length > 0) {
        lines.push(`Hint: ${parts.join(' \u2014 ')}`);
      }
    }

    // Multi-chunk locations — show all significant matching regions
    if (result.chunks && result.chunks.length > 0) {
      lines.push('Matching regions:');
      for (const chunk of result.chunks) {
        const loc = formatLocationHint(chunk.locationHint);
        const section = isRedundantSection(chunk.sectionPath, result.filePath)
          ? ''
          : `"${chunk.sectionPath!.join(' > ')}"`;
        const parts = [loc, section].filter(Boolean).join(' \u2014 ');
        lines.push(`  ${chunk.relevance}% ${parts}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format explore results into a text block for the MCP tool response.
 *
 * When fullContents is false: compact tree with d-puids on directories.
 * When fullContents is true: flat listing with d-puids on subdirectories
 * and r-puids on files.
 */
export function formatExploreResults(results: DirectoryResult[], fullContents: boolean, puid: PuidManager): string {
  if (results.length === 0) {
    return 'No directories found.';
  }

  const lines: string[] = [];

  for (const result of results) {
    const dirPuid = puid.assignDirPuid(result.dirPath);

    // Breadcrumb: look up parent puid (normalised for consistent matching)
    const parentPath = getParentDirPath(result.dirPath);
    const parentPuid = parentPath ? puid.lookupDirPuid(parentPath) : null;
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
          const childPuid = puid.assignDirPuid(child.path);
          const stats = `${child.fileCount} files \u00B7 ${child.subdirCount} subdirs`;
          lines.push(`  ${childPuid.padEnd(5)} ${child.name}/`.padEnd(35) + stats);
        }
      }
      if (result.files && result.files.length > 0) {
        for (const file of result.files) {
          const filePuid = puid.assignFilePuid(file.filePath);
          lines.push(`  ${filePuid.padEnd(5)} ${file.fileName}`);
        }
      }
      if (result.children.length > 0 || (result.files && result.files.length > 0)) {
        lines.push('');
      }
    } else {
      // Compact tree with d-puids
      if (result.children.length > 0) {
        lines.push(...renderTreeWithPuids(result.children, '', puid));
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
  puid: PuidManager,
): string[] {
  const lines: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const connector = isLast ? '\u2514\u2500' : '\u251C\u2500';
    const dirPuid = puid.assignDirPuid(node.path);
    const stats = `${node.fileCount} files \u00B7 ${node.subdirCount} subdirs`;
    lines.push(`${prefix}${connector} ${dirPuid}: ${node.name}/ (${stats})`);

    if (node.children.length > 0) {
      const childPrefix = prefix + (isLast ? '   ' : '\u2502  ');
      lines.push(...renderTreeWithPuids(node.children, childPrefix, puid));
    }
  }
  return lines;
}

// ── Tool Descriptions ────────────────────────────────────────────────────────

export const SEARCH_DESCRIPTION = [
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

export const READ_DESCRIPTION = [
  'Read file contents by reference ID from a previous lodestone_search or lodestone_explore.',
  'Supports text and image files (PNG, JPG, GIF, WebP, SVG).',
  '',
  'Accepts an array of references:',
  '  \u2022 Plain string "r1" \u2014 reads the full file for result r1',
  '  \u2022 Object { id: "r1", location: { type: "lines", start: 10, end: 20 } } \u2014 reads lines 10\u201320',
  '  \u2022 Object { id: "r1", location: { type: "page", page: 3 } } \u2014 reads page 3 of a PDF',
  '',
  'The location parameter accepts the same shape as LocationHint from search results.',
  'For text files (markdown, code, plaintext), use { type: "lines", start, end }.',
  'For PDFs, use { type: "page", page }.',
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
  '  \u2022 [{ id: "r2", location: { type: "lines", start: 10, end: 50 } }] \u2014 read a specific line range',
  '  \u2022 [{ id: "r4", location: { type: "page", page: 5 } }] \u2014 read page 5 of a PDF',
  '  \u2022 ["m5", "r3"] \u2014 read memory m5 and file r3',
  '  \u2022 ["C:/Users/me/docs/notes.md"] \u2014 read a file directly by path (no search needed)',
].join('\n');

export const EXPLORE_DESCRIPTION = [
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

export const EDIT_DESCRIPTION = [
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
