import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import type { FolderKey, FolderRole, MessageKey } from './types';

const SCHEMA_VERSION = '1';

export interface FolderRecord {
  folderKey: FolderKey;
  path: string;
  role: FolderRole;
  selected: boolean;
  uidValidity: number;
  listedCompleteInRound: number | null;
}

export interface MessageRecord {
  messageKey: MessageKey;
  fileName: string;
  receivedAt: string;
  labels: string[] | null;
  contentHash: string;
  fetchedAt: string;
}

export interface MembershipRecord {
  messageKey: MessageKey;
  folderKey: FolderKey;
  seen: boolean;
  flagged: boolean;
  seenInRound: number;
}

interface DbFolderRow {
  folder_key: string;
  path: string;
  role: FolderRole;
  selected: number;
  uidvalidity: number;
  listed_complete_in_round: number | null;
}

interface DbMessageRow {
  message_key: string;
  file_name: string;
  received_at: string;
  labels: string | null;
  content_hash: string;
  fetched_at: string;
}

interface DbMembershipRow {
  message_key: string;
  folder_key: string;
  seen: number;
  flagged: number;
  seen_in_round: number;
}

export class Manifest {
  constructor(private readonly db: BetterSqlite3.Database) {}

  close(): void {
    this.db.close();
  }

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run(key, value);
    });
  }

  deleteState(key: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM state WHERE key = ?').run(key);
    });
  }

  upsertFolder(folder: Omit<FolderRecord, 'listedCompleteInRound'>): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO folder
          (folder_key, path, role, selected, uidvalidity, listed_complete_in_round)
          VALUES (?, ?, ?, ?, ?, NULL)
          ON CONFLICT(folder_key) DO UPDATE SET
            path = excluded.path,
            role = excluded.role,
            selected = excluded.selected,
            uidvalidity = excluded.uidvalidity`,
        )
        .run(
          folder.folderKey,
          folder.path,
          folder.role,
          Number(folder.selected),
          folder.uidValidity,
        );
    });
  }

  folderUidValidity(key: FolderKey): number | null {
    const row = this.db.prepare('SELECT uidvalidity FROM folder WHERE folder_key = ?').get(key) as
      | { uidvalidity: number }
      | undefined;
    return row?.uidvalidity ?? null;
  }

  resetFolder(folderKey: FolderKey): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM membership WHERE folder_key = ?').run(folderKey);
      this.db
        .prepare('UPDATE folder SET listed_complete_in_round = NULL WHERE folder_key = ?')
        .run(folderKey);
    });
  }

  deleteMembershipForFolders(keys: FolderKey[]): void {
    if (keys.length === 0) return;
    this.transaction(() => {
      const statement = this.db.prepare('DELETE FROM membership WHERE folder_key = ?');
      for (const key of keys) statement.run(key);
    });
  }

  deleteFoldersExcept(keys: FolderKey[]): void {
    this.transaction(() => {
      if (keys.length === 0) {
        this.db.prepare('DELETE FROM membership').run();
        this.db.prepare('DELETE FROM folder').run();
        return;
      }
      const placeholders = keys.map(() => '?').join(', ');
      this.db
        .prepare(`DELETE FROM membership WHERE folder_key NOT IN (${placeholders})`)
        .run(...keys);
      this.db.prepare(`DELETE FROM folder WHERE folder_key NOT IN (${placeholders})`).run(...keys);
    });
  }

  upsertMembership(record: MembershipRecord): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO membership
          (message_key, folder_key, seen, flagged, seen_in_round)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(message_key, folder_key) DO UPDATE SET
            seen = excluded.seen,
            flagged = excluded.flagged,
            seen_in_round = excluded.seen_in_round`,
        )
        .run(
          record.messageKey,
          record.folderKey,
          Number(record.seen),
          Number(record.flagged),
          record.seenInRound,
        );
    });
  }

  deleteMembership(messageKey: MessageKey, folderKey: FolderKey): void {
    this.transaction(() => {
      this.db
        .prepare('DELETE FROM membership WHERE message_key = ? AND folder_key = ?')
        .run(messageKey, folderKey);
    });
  }

  membership(messageKey: MessageKey, folderKey: FolderKey): MembershipRecord | null {
    const row = this.db
      .prepare('SELECT * FROM membership WHERE message_key = ? AND folder_key = ?')
      .get(messageKey, folderKey) as DbMembershipRow | undefined;
    return row ? mapMembership(row) : null;
  }

  membershipsForMessage(messageKey: MessageKey): Array<MembershipRecord & { path: string }> {
    const rows = this.db
      .prepare(
        `SELECT m.*, f.path FROM membership m
        JOIN folder f ON f.folder_key = m.folder_key
        WHERE m.message_key = ? ORDER BY f.path`,
      )
      .all(messageKey) as Array<DbMembershipRow & { path: string }>;
    return rows.map((row) => ({ ...mapMembership(row), path: row.path }));
  }

  markListingComplete(folderKey: FolderKey, round: number): void {
    this.transaction(() => {
      this.db
        .prepare('UPDATE folder SET listed_complete_in_round = ? WHERE folder_key = ?')
        .run(round, folderKey);
    });
  }

  deleteUnseenMembership(folderKey: FolderKey, round: number): void {
    this.transaction(() => {
      this.db
        .prepare('DELETE FROM membership WHERE folder_key = ? AND seen_in_round < ?')
        .run(folderKey, round);
    });
  }

  selectedFolders(): FolderRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM folder WHERE selected = 1 ORDER BY folder_key')
        .all() as DbFolderRow[]
    ).map(mapFolder);
  }

  folders(): FolderRecord[] {
    return (this.db.prepare('SELECT * FROM folder ORDER BY folder_key').all() as DbFolderRow[]).map(
      mapFolder,
    );
  }

  allSelectedFoldersComplete(round: number): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM folder
        WHERE selected = 1 AND (listed_complete_in_round IS NULL OR listed_complete_in_round != ?)`,
      )
      .get(round) as { count: number };
    return row.count === 0;
  }

  message(messageKey: MessageKey): MessageRecord | null {
    const row = this.db.prepare('SELECT * FROM message WHERE message_key = ?').get(messageKey) as
      | DbMessageRow
      | undefined;
    return row ? mapMessage(row) : null;
  }

  messageByFileName(fileName: string): MessageRecord | null {
    const row = this.db.prepare('SELECT * FROM message WHERE file_name = ?').get(fileName) as
      | DbMessageRow
      | undefined;
    return row ? mapMessage(row) : null;
  }

  messages(): MessageRecord[] {
    return (
      this.db.prepare('SELECT * FROM message ORDER BY message_key').all() as DbMessageRow[]
    ).map(mapMessage);
  }

  messageCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM message').get() as { count: number };
    return row.count;
  }

  messagesWithoutMembership(): MessageRecord[] {
    return (
      this.db
        .prepare(
          `SELECT msg.* FROM message msg
        LEFT JOIN membership mem ON mem.message_key = msg.message_key
        WHERE mem.message_key IS NULL ORDER BY msg.message_key`,
        )
        .all() as DbMessageRow[]
    ).map(mapMessage);
  }

  insertMessage(record: MessageRecord): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO message
          (message_key, file_name, received_at, labels, content_hash, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(message_key) DO UPDATE SET
            file_name = excluded.file_name,
            received_at = excluded.received_at,
            labels = excluded.labels,
            content_hash = excluded.content_hash,
            fetched_at = excluded.fetched_at`,
        )
        .run(
          record.messageKey,
          record.fileName,
          record.receivedAt,
          record.labels === null ? null : JSON.stringify(record.labels),
          record.contentHash,
          record.fetchedAt,
        );
    });
  }

  updateMessageHash(
    messageKey: MessageKey,
    hash: string,
    labels: string[] | null,
    fetchedAt: string,
  ): void {
    this.transaction(() => {
      this.db
        .prepare(
          'UPDATE message SET content_hash = ?, labels = ?, fetched_at = ? WHERE message_key = ?',
        )
        .run(hash, labels === null ? null : JSON.stringify(labels), fetchedAt, messageKey);
    });
  }

  deleteMessage(messageKey: MessageKey): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM message WHERE message_key = ?').run(messageKey);
    });
  }

  private transaction(action: () => void): void {
    this.db.transaction(action)();
  }
}

export function openManifest(filePath: string): Manifest {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new BetterSqlite3(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS folder (
      folder_key TEXT PRIMARY KEY, path TEXT NOT NULL, role TEXT NOT NULL,
      selected INTEGER NOT NULL, uidvalidity INTEGER NOT NULL,
      listed_complete_in_round INTEGER
    );
    CREATE TABLE IF NOT EXISTS message (
      message_key TEXT PRIMARY KEY, file_name TEXT UNIQUE NOT NULL,
      received_at TEXT NOT NULL, labels TEXT, content_hash TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS membership (
      message_key TEXT NOT NULL, folder_key TEXT NOT NULL, seen INTEGER NOT NULL,
      flagged INTEGER NOT NULL, seen_in_round INTEGER NOT NULL,
      PRIMARY KEY (message_key, folder_key)
    );
  `);
  const manifest = new Manifest(db);
  const version = manifest.getState('schema_version');
  if (version !== null && version !== SCHEMA_VERSION) {
    db.close();
    throw new Error(`Unsupported mail manifest schema version: ${version}`);
  }
  manifest.setState('schema_version', SCHEMA_VERSION);
  if (manifest.getState('current_round') === null) manifest.setState('current_round', '1');
  return manifest;
}

function mapFolder(row: DbFolderRow): FolderRecord {
  return {
    folderKey: row.folder_key,
    path: row.path,
    role: row.role,
    selected: row.selected === 1,
    uidValidity: row.uidvalidity,
    listedCompleteInRound: row.listed_complete_in_round,
  };
}

function mapMessage(row: DbMessageRow): MessageRecord {
  return {
    messageKey: row.message_key,
    fileName: row.file_name,
    receivedAt: row.received_at,
    labels: row.labels === null ? null : (JSON.parse(row.labels) as string[]),
    contentHash: row.content_hash,
    fetchedAt: row.fetched_at,
  };
}

function mapMembership(row: DbMembershipRow): MembershipRecord {
  return {
    messageKey: row.message_key,
    folderKey: row.folder_key,
    seen: row.seen === 1,
    flagged: row.flagged === 1,
    seenInRound: row.seen_in_round,
  };
}
