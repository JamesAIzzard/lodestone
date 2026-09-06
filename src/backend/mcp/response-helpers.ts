/**
 * Shared MCP response helpers — reduce boilerplate for text/error responses.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PuidManager } from './puid-manager';

export function textResponse(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResponse(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }] };
}

/**
 * Resolve a d-puid (e.g. "d5") to an absolute directory path.
 * Returns the resolved path on success, or a CallToolResult error on failure.
 */
export function resolveDirPuid(dirRef: string, puid: PuidManager): string | CallToolResult {
  if (!PuidManager.isDirPuid(dirRef)) return dirRef;

  const resolved = puid.resolvePuidRecord(dirRef);
  if (!resolved) {
    return errorResponse(
      `Unknown directory reference "${dirRef}". It may be from a previous session.`,
    );
  }
  if ('error' in resolved) {
    return errorResponse(resolved.error);
  }
  return resolved.filepath;
}

/** Resolve silo names and s-puids, deduplicating the resulting names in input order. */
export function resolveSiloRefs(
  silo: string | string[] | undefined,
  puid: PuidManager,
): string[] | undefined | CallToolResult {
  if (silo === undefined) return undefined;

  const names: string[] = [];
  const seen = new Set<string>();

  for (const value of Array.isArray(silo) ? silo : [silo]) {
    let name = value;
    if (PuidManager.isSiloPuid(value)) {
      const resolved = puid.resolveSiloPuid(value);
      if (!resolved) {
        return errorResponse(
          `Unknown silo reference "${value}". Use lodestone_status to obtain a fresh reference.`,
        );
      }
      name = resolved;
    }

    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }

  return names;
}
