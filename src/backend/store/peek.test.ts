import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSiloDatabase } from './schema';
import { saveMeta } from './operations';
import { peekIndexState } from './peek';
import { SCHEMA_VERSION } from './types';
import { EMBEDDING_MODEL } from '../embedding-model';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-peek-'));
  tempDirs.push(dir);
  return path.join(dir, 'index.db');
}

function withDb(dbPath: string, fn: (db: Database.Database) => void): void {
  const db = new Database(dbPath);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

describe('peekIndexState', () => {
  it('returns fresh when the database file is missing', () => {
    expect(peekIndexState(tempDbPath())).toBe('fresh');
  });

  it('returns fresh when the database has no files table', () => {
    const dbPath = tempDbPath();
    withDb(dbPath, (db) => {
      db.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
    });

    expect(peekIndexState(dbPath)).toBe('fresh');
  });

  it('returns usable when version, model, and dimensions match', () => {
    const dbPath = tempDbPath();
    const db = createSiloDatabase(dbPath, EMBEDDING_MODEL.dimensions);
    db.close();

    expect(peekIndexState(dbPath)).toBe('usable');
  });

  it('returns unusable when the stored model differs', () => {
    const dbPath = tempDbPath();
    const db = createSiloDatabase(dbPath, EMBEDDING_MODEL.dimensions);
    saveMeta(db, 'some-old-model', EMBEDDING_MODEL.dimensions);
    db.close();

    expect(peekIndexState(dbPath)).toBe('unusable');
  });

  it('returns unusable when the stored dimensions differ', () => {
    const dbPath = tempDbPath();
    const db = createSiloDatabase(dbPath, EMBEDDING_MODEL.dimensions);
    saveMeta(db, EMBEDDING_MODEL.key, EMBEDDING_MODEL.dimensions + 1);
    db.close();

    expect(peekIndexState(dbPath)).toBe('unusable');
  });

  it('returns unusable when version is missing instead of defaulting it', () => {
    const dbPath = tempDbPath();
    const db = createSiloDatabase(dbPath, EMBEDDING_MODEL.dimensions);
    saveMeta(db, EMBEDDING_MODEL.key, EMBEDDING_MODEL.dimensions);
    db.prepare("DELETE FROM meta WHERE key = 'version'").run();
    db.close();

    expect(peekIndexState(dbPath)).toBe('unusable');
  });

  it('returns unusable when model or dimensions are missing', () => {
    for (const key of ['model', 'dimensions']) {
      const dbPath = tempDbPath();
      const db = createSiloDatabase(dbPath, EMBEDDING_MODEL.dimensions);
      saveMeta(db, EMBEDDING_MODEL.key, EMBEDDING_MODEL.dimensions);
      db.prepare('DELETE FROM meta WHERE key = ?').run(key);
      db.close();

      expect(peekIndexState(dbPath)).toBe('unusable');
    }
  });

  it('stamps identity at creation time so interrupted rebuilds resume normally', () => {
    const dbPath = tempDbPath();
    const db = createSiloDatabase(dbPath, EMBEDDING_MODEL.dimensions);
    db.close();

    expect(peekIndexState(dbPath)).toBe('usable');
  });
});

describe('peekIndexState fixtures', () => {
  it('treats a stale schema version as unusable', () => {
    const dbPath = tempDbPath();
    const db = createSiloDatabase(dbPath, EMBEDDING_MODEL.dimensions);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('version', String(SCHEMA_VERSION - 1));
    db.close();

    expect(peekIndexState(dbPath)).toBe('unusable');
  });
});
