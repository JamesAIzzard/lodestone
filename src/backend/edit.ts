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
// trash is ESM-only and externalized by Vite — imported dynamically in executeDelete()

// ── Types ────────────────────────────────────────────────────────────────────

/** Discriminated union for the four text-editing operations. */
export type TextEditOperation =
  | { op: 'str_replace'; filePath: string; oldStr: string; newStr: string; dryRun?: boolean; contextLines?: number; fullDocument?: boolean }
  | { op: 'insert_at_line'; filePath: string; line: number; content: string; dryRun?: boolean; contextLines?: number; fullDocument?: boolean }
  | { op: 'overwrite'; filePath: string; content: string; dryRun?: boolean; contextLines?: number; fullDocument?: boolean }
  | { op: 'append'; filePath: string; content: string; dryRun?: boolean; contextLines?: number; fullDocument?: boolean };

/** Discriminated union for file lifecycle operations. */
export type FileLifecycleOperation =
  | { op: 'create'; directory: string; filename: string; content: string; fullDocument?: boolean }
  | { op: 'mkdir'; directory: string; name: string; dryRun?: boolean }
  | { op: 'rename'; target: string; name: string; dryRun?: boolean }
  | { op: 'move'; target: string; destination: string; destinationType: 'directory' | 'filepath'; onConflict?: 'error' | 'skip' | 'overwrite'; dryRun?: boolean }
  | { op: 'delete'; target: string; dryRun?: boolean };

/** Combined type for all edit operations. */
export type EditOperation = TextEditOperation | FileLifecycleOperation;

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
  /** True when a destination conflict was detected (move). */
  conflict?: boolean;
  /** True when overwrite mode replaced an existing destination file (move). */
  overwritten?: boolean;
  /** SHA-256 hash of the file after the edit (for updating the puid record). */
  newHash?: string;
  /** Resolved source path (move/delete). */
  sourcePath?: string;
  /** Resolved destination path (move only). */
  destinationPath?: string;
  /** Directory listing for source directory (move/delete). */
  sourceDirectoryListing?: string;
  /** Directory listing for destination directory (move/create). */
  destinationDirectoryListing?: string;
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

/** Check whether a path is itself a configured silo root directory. */
function isSiloRoot(target: string, siloDirectories: string[]): boolean {
  const resolved = path.resolve(target);
  return siloDirectories.some(dir => path.resolve(dir) === resolved);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Detect the line ending style used in a string. */
export function detectLineEnding(content: string): 'CRLF' | 'LF' | 'mixed' {
  const crlfCount = (content.match(/\r\n/g) || []).length;
  const lfOnlyCount = (content.match(/(?<!\r)\n/g) || []).length;
  if (crlfCount > 0 && lfOnlyCount > 0) return 'mixed';
  if (crlfCount > 0) return 'CRLF';
  return 'LF';
}

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

  // MCP tool parameters cannot carry \r bytes (JSON double-escaping in the
  // LLM→tool transport turns \r\n into literal backslash-r-backslash-n).
  // When the file uses CRLF, expand bare \n in old_str/new_str to \r\n so
  // the match succeeds against the file's actual bytes.
  const fileEnding = detectLineEnding(oldContent);
  let oldStr = op.oldStr;
  let newStr = op.newStr;
  if (fileEnding === 'CRLF') {
    oldStr = oldStr.replace(/(?<!\r)\n/g, '\r\n');
    newStr = newStr.replace(/(?<!\r)\n/g, '\r\n');
  }

  // Count occurrences
  let count = 0;
  let searchFrom = 0;
  while (true) {
    const idx = oldContent.indexOf(oldStr, searchFrom);
    if (idx === -1) break;
    count++;
    searchFrom = idx + oldStr.length;
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

  // Use indexOf + slice rather than String.replace to avoid JS replacement
  // pattern special characters (e.g. $ → $ in replace's replacement string).
  const matchIdx = oldContent.indexOf(oldStr);
  const newContent = oldContent.slice(0, matchIdx) + newStr + oldContent.slice(matchIdx + oldStr.length);

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

// ── Directory Listing ────────────────────────────────────────────────────────

/**
 * Produce a compact listing of a directory's contents (files and subdirectories),
 * truncated to a maximum number of entries.
 */
function formatDirectoryListing(dirPath: string, maxEntries: number = 20): string {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return `${dirPath} (unreadable)`;
  }
  const files = entries.filter(e => e.isFile()).map(e => e.name);
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name + '/');
  const all = [...dirs.sort(), ...files.sort()];
  const shown = all.slice(0, maxEntries);
  const lines = shown.map(name => `  ${name}`);
  if (all.length > maxEntries) {
    lines.push(`  ... and ${all.length - maxEntries} more`);
  }
  return `${dirPath} (${files.length} files, ${dirs.length} dirs)\n${lines.join('\n')}`;
}

// ── Lifecycle Operations ────────────────────────────────────────────────────

function executeMkdir(
  op: Extract<FileLifecycleOperation, { op: 'mkdir' }>,
  siloDirectories: string[],
): EditResult {
  // Silo boundary check on the parent directory
  if (!isWithinSiloBoundary(op.directory, siloDirectories)) {
    return {
      success: false,
      error: 'Parent directory is outside all configured silo directories. lodestone_edit can only create directories within indexed silos.',
    };
  }

  // Verify the parent directory exists
  if (!fs.existsSync(op.directory) || !fs.statSync(op.directory).isDirectory()) {
    return {
      success: false,
      error: `Parent directory does not exist: ${op.directory}`,
    };
  }

  const newPath = path.join(op.directory, op.name);

  // Check doesn't already exist
  if (fs.existsSync(newPath)) {
    return {
      success: false,
      error: `Directory already exists: ${newPath}`,
    };
  }

  // Dry run — return resolved path without creating
  if (op.dryRun) {
    return {
      success: true,
      sourcePath: newPath,
      destinationDirectoryListing: formatDirectoryListing(op.directory),
    };
  }

  // Live: create the directory
  fs.mkdirSync(newPath);

  return {
    success: true,
    sourcePath: newPath,
    destinationDirectoryListing: formatDirectoryListing(op.directory),
  };
}

function executeCreate(
  op: Extract<FileLifecycleOperation, { op: 'create' }>,
  siloDirectories: string[],
): EditResult {
  // Silo boundary check on the directory
  if (!isWithinSiloBoundary(op.directory, siloDirectories)) {
    return {
      success: false,
      error: 'Directory is outside all configured silo directories. lodestone_edit can only create files within indexed silos.',
    };
  }

  // Verify the directory exists
  if (!fs.existsSync(op.directory) || !fs.statSync(op.directory).isDirectory()) {
    return {
      success: false,
      error: `Directory does not exist: ${op.directory}`,
    };
  }

  // Build full path
  const fullPath = path.join(op.directory, op.filename);

  // Check file doesn't already exist
  if (fs.existsSync(fullPath)) {
    return {
      success: false,
      error: `File already exists: ${fullPath}. Use str_replace or overwrite to modify existing files.`,
    };
  }

  // Write file
  fs.writeFileSync(fullPath, op.content, 'utf-8');
  const newHash = computeHash(Buffer.from(op.content, 'utf-8'));

  // Directory listing for the parent directory
  const destinationDirectoryListing = formatDirectoryListing(op.directory);

  return {
    success: true,
    fullContent: op.content,
    newHash,
    sourcePath: fullPath,
    destinationDirectoryListing,
  };
}

function executeRename(
  op: Extract<FileLifecycleOperation, { op: 'rename' }>,
  siloDirectories: string[],
): EditResult {
  // Silo boundary check
  if (!isWithinSiloBoundary(op.target, siloDirectories)) {
    return {
      success: false,
      error: 'Target is outside all configured silo directories. lodestone_edit can only modify files within indexed silos.',
    };
  }

  // Check source exists
  if (!fs.existsSync(op.target)) {
    return {
      success: false,
      error: `Target not found: ${op.target}`,
    };
  }

  const newPath = path.join(path.dirname(op.target), op.name);

  // Check destination doesn't already exist
  if (fs.existsSync(newPath)) {
    return {
      success: false,
      error: `A file or directory with the name "${op.name}" already exists at: ${newPath}`,
    };
  }

  // Dry run
  if (op.dryRun) {
    return {
      success: true,
      sourcePath: op.target,
      destinationPath: newPath,
      sourceDirectoryListing: formatDirectoryListing(path.dirname(op.target)),
    };
  }

  // Live: rename in place (always same device)
  fs.renameSync(op.target, newPath);

  return {
    success: true,
    sourcePath: op.target,
    destinationPath: newPath,
    sourceDirectoryListing: formatDirectoryListing(path.dirname(op.target)),
  };
}

function executeMove(
  op: Extract<FileLifecycleOperation, { op: 'move' }>,
  siloDirectories: string[],
): EditResult {
  // Silo boundary check on source
  if (!isWithinSiloBoundary(op.target, siloDirectories)) {
    return {
      success: false,
      error: 'Source is outside all configured silo directories. lodestone_edit can only modify files within indexed silos.',
    };
  }

  // Check source exists
  if (!fs.existsSync(op.target)) {
    return {
      success: false,
      error: `Source not found: ${op.target}`,
    };
  }

  // Validate destination_type
  if (op.destinationType === 'directory') {
    if (!fs.existsSync(op.destination) || !fs.statSync(op.destination).isDirectory()) {
      return {
        success: false,
        error: `Destination is not a directory: ${op.destination}`,
      };
    }
  } else {
    // filepath mode
    const parentDir = path.dirname(op.destination);
    if (!fs.existsSync(parentDir)) {
      return {
        success: false,
        error: `Destination parent directory does not exist: ${parentDir}`,
      };
    }
    if (fs.existsSync(op.destination) && fs.statSync(op.destination).isDirectory()) {
      return {
        success: false,
        error: `Destination is an existing directory. Did you mean destination_type: 'directory'?`,
      };
    }
  }

  // Compute final destination path
  const finalDestination = op.destinationType === 'directory'
    ? path.join(op.destination, path.basename(op.target))
    : op.destination;

  // Silo boundary check on destination
  if (!isWithinSiloBoundary(finalDestination, siloDirectories)) {
    return {
      success: false,
      error: 'Destination is outside all configured silo directories. lodestone_edit can only move files within indexed silos.',
    };
  }

  // Directory-specific: detect before collision check (needed for on_conflict policy)
  const isDir = fs.statSync(op.target).isDirectory();

  // Check for collision (skip during dry-run — dry-run block handles conflict detection)
  let didOverwrite = false;
  if (!op.dryRun && fs.existsSync(finalDestination)) {
    const onConflict = op.onConflict ?? 'error';

    // on_conflict only applies to file targets — directory conflicts always error
    if (isDir || onConflict === 'error') {
      return {
        success: false,
        conflict: true,
        error: `A file or directory already exists at the destination: ${finalDestination}`,
      };
    }
    if (onConflict === 'skip') {
      return {
        success: false,
        conflict: true,
        sourcePath: op.target,
        destinationPath: finalDestination,
      };
    }
    // onConflict === 'overwrite': remove destination file, then proceed with move
    fs.unlinkSync(finalDestination);
    didOverwrite = true;
  }

  // Directory-specific: cycle detection
  if (isDir) {
    const resolvedSource = path.resolve(op.target);
    const resolvedDest = path.resolve(finalDestination);
    if (resolvedDest.startsWith(resolvedSource + path.sep)) {
      return {
        success: false,
        error: 'Cannot move a directory into one of its own descendants.',
      };
    }
  }

  // Dry run — return resolved paths and directory listings without moving
  if (op.dryRun) {
    const conflict = fs.existsSync(finalDestination);
    return {
      success: true,
      conflict,
      sourcePath: op.target,
      destinationPath: finalDestination,
      sourceDirectoryListing: formatDirectoryListing(path.dirname(op.target)),
      destinationDirectoryListing: formatDirectoryListing(
        op.destinationType === 'directory' ? op.destination : path.dirname(op.destination),
      ),
    };
  }

  // Live: move the file or directory
  try {
    fs.renameSync(op.target, finalDestination);
  } catch (err: unknown) {
    // Cross-device move — fall back to copy + delete
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      if (isDir) {
        fs.cpSync(op.target, finalDestination, { recursive: true });
        fs.rmSync(op.target, { recursive: true, force: true });
      } else {
        fs.copyFileSync(op.target, finalDestination);
        fs.unlinkSync(op.target);
      }
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to move: ${msg}` };
    }
  }

  return {
    success: true,
    overwritten: didOverwrite || undefined,
    sourcePath: op.target,
    destinationPath: finalDestination,
    sourceDirectoryListing: formatDirectoryListing(path.dirname(op.target)),
    destinationDirectoryListing: formatDirectoryListing(path.dirname(finalDestination)),
  };
}

async function executeDelete(
  op: Extract<FileLifecycleOperation, { op: 'delete' }>,
  siloDirectories: string[],
): Promise<EditResult> {
  // Silo boundary check
  if (!isWithinSiloBoundary(op.target, siloDirectories)) {
    return {
      success: false,
      error: 'Target is outside all configured silo directories. lodestone_edit can only modify files within indexed silos.',
    };
  }

  // Check existence
  if (!fs.existsSync(op.target)) {
    return {
      success: false,
      error: `Target not found: ${op.target}`,
    };
  }

  // Directory-specific: reject deletion of silo root directories
  const isDir = fs.statSync(op.target).isDirectory();
  if (isDir && isSiloRoot(op.target, siloDirectories)) {
    return {
      success: false,
      error: 'Cannot delete a configured silo root directory. Remove or reconfigure the silo first.',
    };
  }

  // Dry run — return the path that would be trashed
  if (op.dryRun) {
    return {
      success: true,
      sourcePath: op.target,
      sourceDirectoryListing: formatDirectoryListing(path.dirname(op.target)),
    };
  }

  // Live: move to OS trash
  try {
    const { default: trash } = await import('trash');
    await trash([op.target]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to trash: ${msg}` };
  }

  return {
    success: true,
    sourcePath: op.target,
    sourceDirectoryListing: formatDirectoryListing(path.dirname(op.target)),
  };
}

// ── Entry Point ──────────────────────────────────────────────────────────────

/**
 * Execute an edit operation (text edit or file lifecycle).
 *
 * @param operation - The edit operation to perform
 * @param defaultContextLines - Default number of context lines from config
 * @param siloDirectories - All silo directories for boundary checking
 */
export async function executeEdit(
  operation: EditOperation,
  defaultContextLines: number,
  siloDirectories: string[],
): Promise<EditResult> {
  switch (operation.op) {
    case 'str_replace':
      return executeStrReplace(operation, defaultContextLines, siloDirectories);
    case 'insert_at_line':
      return executeInsertAtLine(operation, defaultContextLines, siloDirectories);
    case 'overwrite':
      return executeOverwrite(operation, defaultContextLines, siloDirectories);
    case 'append':
      return executeAppend(operation, defaultContextLines, siloDirectories);
    case 'create':
      return executeCreate(operation, siloDirectories);
    case 'mkdir':
      return executeMkdir(operation, siloDirectories);
    case 'rename':
      return executeRename(operation, siloDirectories);
    case 'move':
      return executeMove(operation, siloDirectories);
    case 'delete':
      return executeDelete(operation, siloDirectories);
  }
}
