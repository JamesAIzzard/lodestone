/**
 * Core edit logic for lodestone_edit MCP tool.
 *
 * This module is a pure backend — no MCP protocol awareness. It receives
 * resolved filepaths and returns structured results. The MCP server layer
 * handles puid resolution, staleness checks, and response formatting.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';

// ── Types ────────────────────────────────────────────────────────────────────

/** Discriminated union for the four text-editing operations. */
export type TextEditOperation =
  | { op: 'str_replace'; filePath: string; oldStr: string; newStr: string; dryRun?: boolean; contextLines?: number; fullDocument?: boolean }
  | { op: 'insert_at_line'; filePath: string; line: number; content: string; dryRun?: boolean; contextLines?: number; fullDocument?: boolean }
  | { op: 'overwrite'; filePath: string; content: string; dryRun?: boolean; contextLines?: number; fullDocument?: boolean }
  | { op: 'append'; filePath: string; content: string; dryRun?: boolean; contextLines?: number; fullDocument?: boolean };

export interface EditResult {
  /** True if the operation succeeded (or dry run completed). */
  success: boolean;
  /** Unified diff preview (dry run) or confirmation diff (live edit). */
  diff?: string;
  /** Full document content if full_document was requested. */
  fullContent?: string;
  /** Context snippet around the change site. */
  contextSnippet?: string;
  /** Error message if the operation failed. */
  error?: string;
  /** SHA-256 hash of the file after the edit (for updating the puid record). */
  newHash?: string;
}

// ── Validation ───────────────────────────────────────────────────────────────

/** Validate that a buffer contains valid UTF-8. */
function validateUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/** Check that a filepath falls within at least one silo directory. */
function isWithinSiloBoundary(filePath: string, siloDirectories: string[]): boolean {
  const normalised = path.resolve(filePath);
  return siloDirectories.some(dir => normalised.startsWith(path.resolve(dir) + path.sep) || normalised === path.resolve(dir));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Compute SHA-256 hex digest of raw bytes. */
function computeHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Generate a unified diff between two versions of the same file. */
function generateUnifiedDiff(filePath: string, oldContent: string, newContent: string): string {
  return createTwoFilesPatch(filePath, filePath, oldContent, newContent, 'before', 'after');
}

/**
 * Extract a window of context lines around a change site.
 * Line numbers are 0-indexed internally, displayed as 1-indexed.
 */
function extractContext(content: string, changeStartLine: number, changeEndLine: number, contextLines: number): string {
  const lines = content.split('\n');
  const start = Math.max(0, changeStartLine - contextLines);
  const end = Math.min(lines.length, changeEndLine + contextLines);
  return lines.slice(start, end)
    .map((line, i) => `${(start + i + 1).toString().padStart(4)} | ${line}`)
    .join('\n');
}

/**
 * Find the 0-indexed line range where oldContent and newContent first differ.
 * Returns [startLine, endLine) in the new content.
 */
function findChangeBounds(oldContent: string, newContent: string): { startLine: number; endLine: number } {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // Find first differing line from the top
  let startLine = 0;
  while (startLine < oldLines.length && startLine < newLines.length && oldLines[startLine] === newLines[startLine]) {
    startLine++;
  }

  // Find first differing line from the bottom
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > startLine && newEnd > startLine && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  return { startLine, endLine: newEnd };
}

/** Build the result object with diff/context/fullDocument based on operation flags. */
function buildResult(
  filePath: string,
  oldContent: string,
  newContent: string,
  newHash: string,
  op: { contextLines?: number; fullDocument?: boolean },
  defaultContextLines: number,
): EditResult {
  const diff = generateUnifiedDiff(filePath, oldContent, newContent);
  const result: EditResult = { success: true, diff, newHash };

  if (op.fullDocument) {
    result.fullContent = newContent;
  } else {
    const bounds = findChangeBounds(oldContent, newContent);
    const ctx = op.contextLines ?? defaultContextLines;
    result.contextSnippet = extractContext(newContent, bounds.startLine, bounds.endLine, ctx);
  }

  return result;
}

// ── Read & Validate ──────────────────────────────────────────────────────────

/**
 * Read a file, validate it's within silo boundaries and is valid UTF-8.
 * Returns the buffer and decoded string, or an error result.
 */
function readAndValidate(
  filePath: string,
  siloDirectories: string[],
): { ok: true; buffer: Buffer; content: string } | { ok: false; result: EditResult } {
  // Silo boundary check
  if (!isWithinSiloBoundary(filePath, siloDirectories)) {
    return {
      ok: false,
      result: {
        success: false,
        error: 'File is outside all configured silo directories. lodestone_edit can only modify files within indexed silos.',
      },
    };
  }

  // Read file
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, result: { success: false, error: `Failed to read file: ${msg}` } };
  }

  // UTF-8 validation
  if (!validateUtf8(buffer)) {
    return {
      ok: false,
      result: {
        success: false,
        error: 'File cannot be edited: content is not valid UTF-8. Lodestone edit only supports UTF-8 encoded text files.',
      },
    };
  }

  return { ok: true, buffer, content: buffer.toString('utf-8') };
}

// ── Operations ───────────────────────────────────────────────────────────────

function executeStrReplace(
  op: Extract<TextEditOperation, { op: 'str_replace' }>,
  defaultContextLines: number,
  siloDirectories: string[],
): EditResult {
  const validated = readAndValidate(op.filePath, siloDirectories);
  if (validated.ok === false) return validated.result;
  const { content: oldContent } = validated;

  // Count occurrences
  let count = 0;
  let searchFrom = 0;
  while (true) {
    const idx = oldContent.indexOf(op.oldStr, searchFrom);
    if (idx === -1) break;
    count++;
    searchFrom = idx + op.oldStr.length;
  }

  if (count === 0) {
    return { success: false, error: 'old_str not found in file. No matches.' };
  }
  if (count > 1) {
    return {
      success: false,
      error: `old_str matches ${count} times. It must match exactly once. Provide more surrounding context to make the match unique.`,
    };
  }

  const newContent = oldContent.replace(op.oldStr, op.newStr);

  if (op.dryRun) {
    return { success: true, diff: generateUnifiedDiff(op.filePath, oldContent, newContent) };
  }

  fs.writeFileSync(op.filePath, newContent, 'utf-8');
  const newHash = computeHash(Buffer.from(newContent, 'utf-8'));
  return buildResult(op.filePath, oldContent, newContent, newHash, op, defaultContextLines);
}

function executeInsertAtLine(
  op: Extract<TextEditOperation, { op: 'insert_at_line' }>,
  defaultContextLines: number,
  siloDirectories: string[],
): EditResult {
  const validated = readAndValidate(op.filePath, siloDirectories);
  if (validated.ok === false) return validated.result;
  const { content: oldContent } = validated;

  const lines = oldContent.split('\n');
  const lineCount = lines.length;

  if (op.line < 1 || op.line > lineCount + 1) {
    return {
      success: false,
      error: `Line ${op.line} is out of range. Valid range: 1 to ${lineCount + 1}.`,
    };
  }

  // Insert before the specified line (1-indexed → 0-indexed)
  const insertLines = op.content.split('\n');
  lines.splice(op.line - 1, 0, ...insertLines);
  const newContent = lines.join('\n');

  if (op.dryRun) {
    return { success: true, diff: generateUnifiedDiff(op.filePath, oldContent, newContent) };
  }

  fs.writeFileSync(op.filePath, newContent, 'utf-8');
  const newHash = computeHash(Buffer.from(newContent, 'utf-8'));
  return buildResult(op.filePath, oldContent, newContent, newHash, op, defaultContextLines);
}

function executeOverwrite(
  op: Extract<TextEditOperation, { op: 'overwrite' }>,
  defaultContextLines: number,
  siloDirectories: string[],
): EditResult {
  const validated = readAndValidate(op.filePath, siloDirectories);
  if (validated.ok === false) return validated.result;
  const { content: oldContent } = validated;

  if (op.dryRun) {
    return { success: true, diff: generateUnifiedDiff(op.filePath, oldContent, op.content) };
  }

  fs.writeFileSync(op.filePath, op.content, 'utf-8');
  const newHash = computeHash(Buffer.from(op.content, 'utf-8'));
  return buildResult(op.filePath, oldContent, op.content, newHash, op, defaultContextLines);
}

function executeAppend(
  op: Extract<TextEditOperation, { op: 'append' }>,
  defaultContextLines: number,
  siloDirectories: string[],
): EditResult {
  const validated = readAndValidate(op.filePath, siloDirectories);
  if (validated.ok === false) return validated.result;
  const { content: oldContent } = validated;

  // Ensure a newline separator if the file doesn't end with one
  const separator = oldContent.length > 0 && !oldContent.endsWith('\n') ? '\n' : '';
  const newContent = oldContent + separator + op.content;

  if (op.dryRun) {
    return { success: true, diff: generateUnifiedDiff(op.filePath, oldContent, newContent) };
  }

  fs.writeFileSync(op.filePath, newContent, 'utf-8');
  const newHash = computeHash(Buffer.from(newContent, 'utf-8'));
  return buildResult(op.filePath, oldContent, newContent, newHash, op, defaultContextLines);
}

// ── Entry Point ──────────────────────────────────────────────────────────────

/**
 * Execute a text edit operation.
 *
 * @param operation - The edit operation to perform
 * @param defaultContextLines - Default number of context lines from config
 * @param siloDirectories - All silo directories for boundary checking
 */
export function executeEdit(
  operation: TextEditOperation,
  defaultContextLines: number,
  siloDirectories: string[],
): EditResult {
  switch (operation.op) {
    case 'str_replace':
      return executeStrReplace(operation, defaultContextLines, siloDirectories);
    case 'insert_at_line':
      return executeInsertAtLine(operation, defaultContextLines, siloDirectories);
    case 'overwrite':
      return executeOverwrite(operation, defaultContextLines, siloDirectories);
    case 'append':
      return executeAppend(operation, defaultContextLines, siloDirectories);
  }
}
