/**
 * Edit tool registration — 9 sub-operations for file and memory editing.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import fs from 'node:fs';
import type { McpServerDeps } from './types';
import { PuidManager, type PuidRecord } from './puid-manager';
import { EDIT_DESCRIPTION } from './formatting';
import { textResponse, errorResponse, resolveDirPuid } from './response-helpers';

// ── Target resolution helper ─────────────────────────────────────────────────

interface ResolvedTarget { filePath: string; puidKey?: string; puidRecord?: PuidRecord; isDirectory: boolean }

/**
 * Resolve a target reference (r-puid, d-puid, or raw path) to a filepath
 * with optional puid metadata. Returns an error string if the puid is
 * unknown or invalidated.
 */
function resolveTarget(target: string, puid: PuidManager): ResolvedTarget | string {
  if (/^r\d+$/.test(target)) {
    const resolved = puid.resolvePuidRecord(target);
    if (!resolved) {
      return `Unknown puid "${target}". It may be from a previous session.`;
    }
    if ('error' in resolved) {
      return resolved.error;
    }
    return { filePath: resolved.filepath, puidKey: target, puidRecord: resolved, isDirectory: false };
  }

  if (PuidManager.isDirPuid(target)) {
    const resolved = puid.resolvePuidRecord(target);
    if (!resolved) {
      return `Unknown directory reference "${target}". It may be from a previous session.`;
    }
    if ('error' in resolved) {
      return resolved.error;
    }
    return { filePath: resolved.filepath, puidKey: target, puidRecord: resolved, isDirectory: true };
  }

  // Raw path
  let isDirectory = false;
  try { isDirectory = fs.statSync(target).isDirectory(); } catch { /* will fail in edit */ }
  return { filePath: target, isDirectory };
}

/**
 * Check if a file has been modified externally since last read.
 * Returns an error message if stale, or null if fresh.
 * Refreshes the stored hash on staleness detection.
 */
function checkStaleness(filePath: string, puidRecord?: PuidRecord): string | null {
  if (!puidRecord?.contentHash) return null;
  const currentHash = PuidManager.computeFileHash(filePath);
  if (currentHash === puidRecord.contentHash) return null;
  // Stale — refresh hash and return error
  const oldHash = puidRecord.contentHash;
  puidRecord.contentHash = currentHash;
  return `File has been modified externally since last read. Call lodestone_read to get the current content before retrying the edit.\nStored hash: ${oldHash}\nCurrent hash: ${currentHash}`;
}

/**
 * Invalidate puids for a resolved target after a successful mutating operation
 * (rename, move, or delete). Handles both file and directory targets.
 */
function invalidateTarget(puid: PuidManager, resolved: ResolvedTarget): void {
  if (resolved.puidKey) puid.invalidatePuid(resolved.puidKey);
  if (resolved.isDirectory) {
    puid.invalidateByPathPrefix(resolved.filePath);
  } else {
    puid.invalidateByPath(resolved.filePath);
  }
}

// ── Per-operation handlers ───────────────────────────────────────────────────

interface HandlerContext {
  deps: McpServerDeps;
  puid: PuidManager;
  siloDirectories: string[];
}

async function handleCreate(
  ctx: HandlerContext,
  directory: string | undefined, filename: string | undefined, content: string | undefined, full_document: boolean | undefined,
): Promise<CallToolResult> {
  if (directory === undefined || filename === undefined || content === undefined) {
    return errorResponse('create requires directory, filename, and content parameters.');
  }

  // Resolve d-puid
  const dirResult = resolveDirPuid(directory, ctx.puid);
  if (typeof dirResult !== 'string') return dirResult;

  const result = await ctx.deps.silo.edit({
    operation: { op: 'create', directory: dirResult, filename, content, fullDocument: full_document },
    contextLines: 0,
    siloDirectories: ctx.siloDirectories,
  });

  if (!result.success) {
    return errorResponse(result.error!);
  }

  // Assign puid for the new file and cache the hash
  const newFilePath = result.sourcePath!;
  const newPuid = ctx.puid.assignFilePuid(newFilePath);
  const newRecord = ctx.puid.getRecord(newPuid)!;
  newRecord.contentHash = result.newHash;

  // Format response
  const parts: string[] = [`Created ${newPuid}: ${newFilePath}`];
  if (result.fullContent) {
    parts.push('');
    parts.push(result.fullContent);
  }
  return textResponse(parts.join('\n'));
}

async function handleMkdir(
  ctx: HandlerContext,
  directory: string | undefined, name: string | undefined, dry_run: boolean | undefined,
): Promise<CallToolResult> {
  if (directory === undefined || name === undefined) {
    return errorResponse('mkdir requires directory and name parameters.');
  }

  // Resolve d-puid
  const dirResult = resolveDirPuid(directory, ctx.puid);
  if (typeof dirResult !== 'string') return dirResult;

  const result = await ctx.deps.silo.edit({
    operation: { op: 'mkdir', directory: dirResult, name, dryRun: dry_run },
    contextLines: 0,
    siloDirectories: ctx.siloDirectories,
  });

  if (!result.success) {
    return errorResponse(result.error!);
  }

  // Assign d-puid for the new directory
  const newDirPath = result.sourcePath!;
  if (!dry_run) {
    const newPuid = ctx.puid.assignDirPuid(newDirPath);
    const parts: string[] = [`Created ${newPuid}: ${newDirPath}`];
    if (result.destinationDirectoryListing) {
      parts.push('');
      parts.push('Parent directory:');
      parts.push(result.destinationDirectoryListing);
    }
    return textResponse(parts.join('\n'));
  } else {
    const parts: string[] = [`Dry run \u2014 directory would be created: ${newDirPath}`];
    if (result.destinationDirectoryListing) {
      parts.push('');
      parts.push('Parent directory:');
      parts.push(result.destinationDirectoryListing);
    }
    return textResponse(parts.join('\n'));
  }
}

async function handleRename(
  ctx: HandlerContext,
  target: string | string[] | undefined, name: string | undefined, dry_run: boolean | undefined,
): Promise<CallToolResult> {
  if (target === undefined || typeof target !== 'string') {
    return errorResponse('rename requires a single target parameter (not an array).');
  }
  if (!name) {
    return errorResponse('rename requires name parameter.');
  }

  const resolved = resolveTarget(target, ctx.puid);
  if (typeof resolved === 'string') {
    return errorResponse(resolved);
  }
  const { filePath, puidRecord, isDirectory } = resolved;

  // Staleness check (files only)
  if (!isDirectory) {
    const staleMsg = checkStaleness(filePath, puidRecord);
    if (staleMsg) {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      return textResponse(`${staleMsg}\n\nCurrent file content:\n\`\`\`\n${fileContent}\n\`\`\``);
    }
  }

  const result = await ctx.deps.silo.edit({
    operation: { op: 'rename', target: filePath, name, dryRun: dry_run },
    contextLines: 0,
    siloDirectories: ctx.siloDirectories,
  });

  if (!result.success) {
    return errorResponse(result.error!);
  }

  // Invalidate old puids and assign new ones on live (non-dry-run) renames
  if (!dry_run) {
    invalidateTarget(ctx.puid, resolved);

    // Assign new puid at the new path
    const newPath = result.destinationPath!;
    const parts: string[] = [];
    if (isDirectory) {
      const newId = ctx.puid.assignDirPuid(newPath);
      parts.push(`Renamed ${newId}: ${result.sourcePath} \u2192 ${newPath}`);
    } else {
      const newId = ctx.puid.assignFilePuid(newPath);
      parts.push(`Renamed ${newId}: ${result.sourcePath} \u2192 ${newPath}`);
    }
    if (result.sourceDirectoryListing) {
      parts.push('');
      parts.push('Directory:');
      parts.push(result.sourceDirectoryListing);
    }
    return textResponse(parts.join('\n'));
  } else {
    const parts: string[] = [`Dry run \u2014 would rename:`];
    parts.push(`  ${result.sourcePath} \u2192 ${result.destinationPath}`);
    if (result.sourceDirectoryListing) {
      parts.push('');
      parts.push('Directory:');
      parts.push(result.sourceDirectoryListing);
    }
    return textResponse(parts.join('\n'));
  }
}

async function handleMove(
  ctx: HandlerContext,
  target: string | string[] | undefined,
  destination: string | undefined, destination_type: 'directory' | 'filepath' | undefined,
  on_conflict: 'error' | 'skip' | 'overwrite' | undefined, dry_run: boolean | undefined,
): Promise<CallToolResult> {
  if (target === undefined) {
    return errorResponse('move requires target parameter.');
  }
  if (destination === undefined || destination_type === undefined) {
    return errorResponse('move requires destination and destination_type parameters.');
  }

  // Batch mode
  if (Array.isArray(target)) {
    return handleBatchMove(ctx, target, destination, destination_type, on_conflict, dry_run);
  }

  // ── Single-target move ──
  const resolved = resolveTarget(target, ctx.puid);
  if (typeof resolved === 'string') {
    return errorResponse(resolved);
  }
  const { filePath, puidRecord, isDirectory } = resolved;

  // Staleness check (files only — directories don't have content hashes)
  const staleMsg = checkStaleness(filePath, puidRecord);
  if (staleMsg) {
    return textResponse(staleMsg);
  }

  // Resolve destination (d-puid or path)
  const destResult = resolveDirPuid(destination, ctx.puid);
  if (typeof destResult !== 'string') return destResult;

  const result = await ctx.deps.silo.edit({
    operation: { op: 'move', target: filePath, destination: destResult, destinationType: destination_type, onConflict: on_conflict, dryRun: dry_run },
    contextLines: 0,
    siloDirectories: ctx.siloDirectories,
  });

  if (!result.success) {
    if (result.conflict && on_conflict === 'skip') {
      return textResponse(`Skipped: file already exists at destination: ${result.destinationPath}`);
    }
    if (result.conflict) {
      return textResponse(`Conflict: ${result.error}`);
    }
    return errorResponse(result.error!);
  }

  // Invalidate puids on live (non-dry-run) moves
  if (!dry_run) {
    invalidateTarget(ctx.puid, resolved);
  }

  // Format response
  const moveParts: string[] = [];
  if (dry_run && result.conflict) {
    moveParts.push(`Dry run \u2014 would be moved (CONFLICT \u2014 destination exists):`);
    moveParts.push(`  ${result.sourcePath} \u2192 ${result.destinationPath}`);
  } else if (dry_run) {
    moveParts.push(`Dry run \u2014 would be moved:`);
    moveParts.push(`  ${result.sourcePath} \u2192 ${result.destinationPath}`);
  } else if (result.overwritten) {
    moveParts.push(`Moved (overwritten): ${result.sourcePath} \u2192 ${result.destinationPath}`);
  } else {
    moveParts.push(`Moved: ${result.sourcePath} \u2192 ${result.destinationPath}`);
  }
  if (result.sourceDirectoryListing) {
    moveParts.push('');
    moveParts.push('Source directory:');
    moveParts.push(result.sourceDirectoryListing);
  }
  if (result.destinationDirectoryListing) {
    moveParts.push('');
    moveParts.push('Destination directory:');
    moveParts.push(result.destinationDirectoryListing);
  }
  return textResponse(moveParts.join('\n'));
}

async function handleBatchMove(
  ctx: HandlerContext,
  targets: string[],
  destination: string, destination_type: 'directory' | 'filepath',
  on_conflict: 'error' | 'skip' | 'overwrite' | undefined, dry_run: boolean | undefined,
): Promise<CallToolResult> {
  // Resolve destination (d-puid or path) — shared across all batch elements
  const destResult = resolveDirPuid(destination, ctx.puid);
  if (typeof destResult !== 'string') return destResult;

  const batchResults: { source: string; destination?: string; success: boolean; error?: string; conflict?: boolean; overwritten?: boolean; destListing?: string }[] = [];

  for (const element of targets) {
    const resolved = resolveTarget(element, ctx.puid);
    if (typeof resolved === 'string') {
      batchResults.push({ source: element, success: false, error: resolved });
      continue;
    }
    const { filePath, puidRecord } = resolved;

    // Staleness check (files only)
    const staleMsg = checkStaleness(filePath, puidRecord);
    if (staleMsg) {
      batchResults.push({ source: filePath, success: false, error: 'File has been modified externally since last read.' });
      continue;
    }

    const result = await ctx.deps.silo.edit({
      operation: { op: 'move', target: filePath, destination: destResult, destinationType: destination_type, onConflict: on_conflict, dryRun: dry_run },
      contextLines: 0,
      siloDirectories: ctx.siloDirectories,
    });

    if (!result.success) {
      batchResults.push({ source: filePath, success: false, error: result.error, conflict: result.conflict });
      continue;
    }

    batchResults.push({ source: filePath, destination: result.destinationPath, success: true, overwritten: result.overwritten, conflict: result.conflict, destListing: result.destinationDirectoryListing });

    // Invalidate puids on live (non-dry-run) moves
    if (!dry_run) {
      invalidateTarget(ctx.puid, resolved);
    }
  }

  // Format collapsed batch response
  const parts: string[] = [];

  for (const r of batchResults) {
    if (r.success && r.overwritten) {
      parts.push(`  [OVERWRITE] ${r.source} \u2192 ${r.destination}`);
    } else if (r.success && dry_run && r.conflict) {
      parts.push(`  [CONFLICT] ${r.source} \u2192 ${r.destination}`);
    } else if (r.success && dry_run) {
      parts.push(`  [WOULD MOVE] ${r.source} \u2192 ${r.destination}`);
    } else if (r.success) {
      parts.push(`  [OK] ${r.source} \u2192 ${r.destination}`);
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
  return textResponse(parts.join('\n'));
}

async function handleDelete(
  ctx: HandlerContext,
  target: string | string[] | undefined, dry_run: boolean | undefined,
): Promise<CallToolResult> {
  if (target === undefined) {
    return errorResponse('delete requires target parameter.');
  }

  // Batch mode
  if (Array.isArray(target)) {
    return handleBatchDelete(ctx, target, dry_run);
  }

  // ── Single-target delete ──

  // Memory references are handled by the cloud Worker, not locally
  if (PuidManager.isMemoryPuid(target)) {
    return errorResponse('Memory references (m-prefixed IDs) are handled by the lodestone-memory server.');
  }

  const resolved = resolveTarget(target, ctx.puid);
  if (typeof resolved === 'string') {
    return errorResponse(resolved);
  }
  const { filePath, puidRecord } = resolved;

  // Staleness check (files only — directories don't have content hashes)
  const staleMsg = checkStaleness(filePath, puidRecord);
  if (staleMsg) {
    return textResponse(staleMsg);
  }

  const result = await ctx.deps.silo.edit({
    operation: { op: 'delete', target: filePath, dryRun: dry_run },
    contextLines: 0,
    siloDirectories: ctx.siloDirectories,
  });

  if (!result.success) {
    return errorResponse(result.error!);
  }

  // Invalidate puids on live (non-dry-run) deletes
  if (!dry_run) {
    invalidateTarget(ctx.puid, resolved);
  }

  // Format response
  const parts: string[] = [];
  if (dry_run) {
    parts.push(`Dry run \u2014 would be moved to trash:`);
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
  return textResponse(parts.join('\n'));
}

async function handleBatchDelete(
  ctx: HandlerContext,
  targets: string[], dry_run: boolean | undefined,
): Promise<CallToolResult> {
  const batchResults: { source: string; success: boolean; error?: string }[] = [];

  for (const element of targets) {
    // Memory references are handled by the cloud Worker, not locally
    if (PuidManager.isMemoryPuid(element)) {
      batchResults.push({ source: element, success: false, error: 'Memory references (m-prefixed IDs) are handled by the lodestone-memory server.' });
      continue;
    }

    const resolved = resolveTarget(element, ctx.puid);
    if (typeof resolved === 'string') {
      batchResults.push({ source: element, success: false, error: resolved });
      continue;
    }
    const { filePath, puidRecord } = resolved;

    // Staleness check (files only)
    const staleMsg = checkStaleness(filePath, puidRecord);
    if (staleMsg) {
      batchResults.push({ source: filePath, success: false, error: 'File has been modified externally since last read.' });
      continue;
    }

    const result = await ctx.deps.silo.edit({
      operation: { op: 'delete', target: filePath, dryRun: dry_run },
      contextLines: 0,
      siloDirectories: ctx.siloDirectories,
    });

    if (!result.success) {
      batchResults.push({ source: filePath, success: false, error: result.error });
      continue;
    }

    batchResults.push({ source: filePath, success: true });

    if (!dry_run) {
      invalidateTarget(ctx.puid, resolved);
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
  return textResponse(parts.join('\n'));
}

async function handleTextEdit(
  ctx: HandlerContext,
  operation: 'str_replace' | 'insert_at_line' | 'overwrite' | 'append',
  target: string | string[] | undefined,
  old_str: string | undefined, new_str: string | undefined,
  line: number | undefined, content: string | undefined,
  dry_run: boolean | undefined, context_lines: number | undefined, full_document: boolean | undefined,
): Promise<CallToolResult> {
  if (target === undefined) {
    return errorResponse(`${operation} requires target parameter.`);
  }
  if (Array.isArray(target)) {
    return errorResponse('Batch mode is only supported for move and delete operations.');
  }

  // Memory references are handled by the cloud Worker, not locally
  if (PuidManager.isMemoryPuid(target)) {
    return errorResponse('Memory references (m-prefixed IDs) are handled by the lodestone-memory server.');
  }

  // 1. Resolve file reference
  let filePath: string;
  let puidRecord: PuidRecord | undefined;
  if (/^r\d+$/.test(target)) {
    const resolved = ctx.puid.resolvePuidRecord(target);
    if (!resolved) {
      return errorResponse(`Unknown puid "${target}". It may be from a previous session. Search or explore again to get a fresh reference.`);
    }
    if ('error' in resolved) {
      return errorResponse(resolved.error);
    }
    puidRecord = resolved;
    filePath = resolved.filepath;
  } else {
    filePath = target;
  }

  // 2. Staleness check (puid path only — raw filepaths skip this)
  if (puidRecord?.contentHash) {
    const currentHash = PuidManager.computeFileHash(filePath);
    if (currentHash !== puidRecord.contentHash) {
      let body = `File has been modified externally since last read. Call lodestone_read to get the current content before retrying the edit.\nStored hash: ${puidRecord.contentHash}\nCurrent hash: ${currentHash}`;
      try {
        const currentContent = fs.readFileSync(filePath, 'utf-8');
        body += `\n\nCurrent content:\n\`\`\`\n${currentContent}\n\`\`\``;
      } catch { /* if read fails, just show hashes */ }
      puidRecord.contentHash = currentHash;
      return textResponse(body);
    }
  }

  // 3. Resolve context_lines default
  const defaults = await ctx.deps.silo.getDefaults();
  const effectiveContextLines = context_lines ?? defaults.contextLines;

  // 4. Build operation and dispatch
  let editOp: import('../edit').EditOperation;
  switch (operation) {
    case 'str_replace':
      if (old_str === undefined || new_str === undefined) {
        return errorResponse('str_replace requires old_str and new_str parameters.');
      }
      editOp = { op: 'str_replace', filePath, oldStr: old_str, newStr: new_str, dryRun: dry_run, contextLines: context_lines, fullDocument: full_document };
      break;
    case 'insert_at_line':
      if (line === undefined || content === undefined) {
        return errorResponse('insert_at_line requires line and content parameters.');
      }
      editOp = { op: 'insert_at_line', filePath, line, content, dryRun: dry_run, contextLines: context_lines, fullDocument: full_document };
      break;
    case 'overwrite':
      if (content === undefined) {
        return errorResponse('overwrite requires content parameter.');
      }
      editOp = { op: 'overwrite', filePath, content, dryRun: dry_run, contextLines: context_lines, fullDocument: full_document };
      break;
    case 'append':
      if (content === undefined) {
        return errorResponse('append requires content parameter.');
      }
      editOp = { op: 'append', filePath, content, dryRun: dry_run, contextLines: context_lines, fullDocument: full_document };
      break;
  }

  const result = await ctx.deps.silo.edit({
    operation: editOp,
    contextLines: effectiveContextLines,
    siloDirectories: ctx.siloDirectories,
  });

  // 5. Update puid hash on success (non-dry-run)
  if (result.success && !dry_run && result.newHash && puidRecord) {
    puidRecord.contentHash = result.newHash;
  }

  // 6. Format response
  if (!result.success) {
    return errorResponse(result.error!);
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

  return textResponse(parts.join('\n'));
}

// ── Tool registration ────────────────────────────────────────────────────────

export function registerEditTool(server: McpServer, deps: McpServerDeps, puid: PuidManager): void {
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
        const statusResult = await deps.silo.status();
        const siloDirectories = statusResult.silos.flatMap(s => s.config.directories);
        const ctx: HandlerContext = { deps, puid, siloDirectories };

        switch (operation) {
          case 'create':
            return await handleCreate(ctx, directory, filename, content, full_document);
          case 'mkdir':
            return await handleMkdir(ctx, directory, name, dry_run);
          case 'rename':
            return await handleRename(ctx, target, name, dry_run);
          case 'move':
            return await handleMove(ctx, target, destination, destination_type, on_conflict, dry_run);
          case 'delete':
            return await handleDelete(ctx, target, dry_run);
          default:
            return await handleTextEdit(ctx, operation, target, old_str, new_str, line, content, dry_run, context_lines, full_document);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResponse(message);
      }
    },
  );
}
