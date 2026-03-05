-- Lodestone Memory — D1 Schema (Phase 1)
--
-- Mirrors the local SQLite schema from src/backend/memory-store/schema.ts,
-- minus the vec_rowid column and memories_vec virtual table (Phase 3: Vectorize).

-- Main memory table
CREATE TABLE IF NOT EXISTS memories (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  topic           TEXT    NOT NULL,
  body            TEXT    NOT NULL,
  confidence      REAL    NOT NULL DEFAULT 1.0,
  context_hint    TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  token_count     INTEGER NOT NULL DEFAULT 0,
  action_date     TEXT,
  recurrence      TEXT,
  priority        INTEGER,
  status          TEXT,
  completed_on    TEXT,
  deleted_at      TEXT,
  deletion_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_action_date
  ON memories(action_date) WHERE action_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_status
  ON memories(status) WHERE status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_completed_on
  ON memories(completed_on) WHERE completed_on IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_deleted
  ON memories(deleted_at) WHERE deleted_at IS NOT NULL;

-- Key-value metadata store (corpus stats, model info)
CREATE TABLE IF NOT EXISTS memory_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- BM25 inverted index: document frequencies per term
CREATE TABLE IF NOT EXISTS memory_terms (
  term     TEXT    PRIMARY KEY,
  doc_freq INTEGER NOT NULL DEFAULT 0
);

-- BM25 inverted index: per-memory term frequencies
CREATE TABLE IF NOT EXISTS memory_postings (
  term      TEXT    NOT NULL,
  memory_id INTEGER NOT NULL,
  term_freq INTEGER NOT NULL,
  PRIMARY KEY (term, memory_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_postings_memory
  ON memory_postings(memory_id);

-- Seed corpus stats
INSERT OR IGNORE INTO memory_metadata (key, value) VALUES ('corpus_memory_count', '0');
INSERT OR IGNORE INTO memory_metadata (key, value) VALUES ('corpus_avg_token_count', '0');
