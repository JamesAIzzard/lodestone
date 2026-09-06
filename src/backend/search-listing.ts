import type { ListingParams } from '../shared/types';
import { passesFileFilters, type FileFilters } from './scorers/signal';
import type { FileResult } from './search';
import { globToRegex } from './store/paths';
import type { SiloDatabase } from './store/types';

export interface ListingResult {
  results: FileResult[];
  total: number;
}

interface ListingRow {
  stored_key: string;
  date_ms: number;
}

export function listByDate(db: SiloDatabase, params: ListingParams): ListingResult {
  const limit = params.limit ?? 10;
  const offset = params.offset ?? 0;
  const filters: FileFilters = {
    startPath: params.startPath,
    filePatternRe: params.filePattern ? globToRegex(params.filePattern) : null,
    dateFromMs: params.dateFromMs,
    dateToMs: params.dateToMs,
  };
  const rows = db
    .prepare(
      `SELECT stored_key, date_ms FROM files
       WHERE date_ms IS NOT NULL AND date_ms >= ? AND date_ms <= ?
       ORDER BY date_ms DESC, stored_key ASC`,
    )
    .all(params.dateFromMs ?? -1e18, params.dateToMs ?? 1e18) as ListingRow[];

  const results: FileResult[] = [];
  let total = 0;
  for (const row of rows) {
    if (!passesFileFilters(filters, row.stored_key, row.date_ms)) continue;
    total += 1;
    if (results.length < offset + limit) {
      results.push({
        filePath: row.stored_key,
        dateMs: row.date_ms,
        score: 1,
        scoreLabel: 'date',
        signals: { date: 1 },
      });
    }
  }

  return { results, total };
}
