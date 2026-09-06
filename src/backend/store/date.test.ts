import { afterEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { DATE_MS_SQL_EXPRESSION, deriveDateMs } from './date';

const databases: BetterSqlite3.Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('deriveDateMs', () => {
  it('uses a valid received_at ISO timestamp', () => {
    const receivedAt = '2025-12-21T07:15:26.123Z';

    expect(deriveDateMs({ received_at: receivedAt }, 1000)).toBe(Date.parse(receivedAt));
  });

  it.each([
    ['absent', {}, 1000],
    ['null', { received_at: null }, 2000],
    ['non-string', { received_at: 123 }, 3000],
    ['unparseable', { received_at: 'not-a-date' }, 4000],
  ])('falls back to mtime when received_at is %s', (_label, metadata, mtimeMs) => {
    expect(deriveDateMs(metadata, mtimeMs)).toBe(mtimeMs);
  });

  it('returns null when both sources are absent', () => {
    expect(deriveDateMs(undefined, undefined)).toBeNull();
    expect(deriveDateMs({}, null)).toBeNull();
  });

  it('matches the schema migration SQL expression', () => {
    const fixtures: Array<{
      metadata: Record<string, unknown> | undefined;
      mtimeMs: number | null;
    }> = [
      { metadata: { received_at: '2025-12-21T07:15:26.123Z' }, mtimeMs: 1000 },
      { metadata: {}, mtimeMs: 2000 },
      { metadata: { received_at: null }, mtimeMs: 3000 },
      { metadata: { received_at: 123 }, mtimeMs: 4000 },
      { metadata: { received_at: 'not-a-date' }, mtimeMs: 5000 },
      { metadata: undefined, mtimeMs: null },
    ];
    const db = new BetterSqlite3(':memory:');
    databases.push(db);
    db.exec(`CREATE TABLE fixture (file_metadata TEXT NOT NULL, mtime_ms REAL)`);
    const insert = db.prepare('INSERT INTO fixture (file_metadata, mtime_ms) VALUES (?, ?)');
    for (const fixture of fixtures) {
      insert.run(JSON.stringify(fixture.metadata ?? {}), fixture.mtimeMs);
    }

    const rows = db
      .prepare(`SELECT ${DATE_MS_SQL_EXPRESSION} AS date_ms FROM fixture ORDER BY rowid`)
      .all() as Array<{ date_ms: number | null }>;

    expect(rows.map((row) => row.date_ms)).toEqual(
      fixtures.map((fixture) => deriveDateMs(fixture.metadata, fixture.mtimeMs)),
    );
  });
});
