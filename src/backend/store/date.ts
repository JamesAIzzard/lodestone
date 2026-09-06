/**
 * SQL equivalent of deriveDateMs, shared with the migration-equivalence test.
 * Keep this expression in sync with scripts/migrate-schema-6.py.
 */
export const DATE_MS_SQL_EXPRESSION = `COALESCE(
  CASE WHEN json_type(file_metadata, '$.received_at') = 'text'
    THEN unixepoch(json_extract(file_metadata, '$.received_at'), 'subsec') * 1000
  END,
  mtime_ms
)`;

/** Derive the searchable date for a file from its metadata and modification time. */
export function deriveDateMs(
  fileMetadata: Record<string, unknown> | undefined,
  mtimeMs: number | null | undefined,
): number | null {
  const receivedAt = fileMetadata?.received_at;
  if (typeof receivedAt === 'string') {
    const parsed = Date.parse(receivedAt);
    if (Number.isFinite(parsed)) return parsed;
  }

  return mtimeMs ?? null;
}
