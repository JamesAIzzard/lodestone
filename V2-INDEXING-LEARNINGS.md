# Lodestone V2 Indexing — Learnings & Design Notes

## Date: 2026-02-28
## Context: Diagnostic session instrumenting reconcile.ts with timing logs

---

## Critical Performance Findings

### 1. Hand-rolled inverted index is the primary write bottleneck

**The problem:** `upsertFileInner` tokenizes each chunk (~300 unique terms), then runs
individual `INSERT OR CONFLICT` on `terms` table and `INSERT` on `postings` table for
EACH term separately.

**Measured impact:**
- ~600 SQL statements per chunk just for inverted index maintenance
- For a 5-chunk file: ~3,000 individual SQL operations → **6.3 seconds**
- For a 2338-chunk PDF (Advanced Engineering Mathematics): ~700,000 SQL operations → **128 seconds**
- Per-file cost is ~6.3 seconds **REGARDLESS of chunk count** once tables have grown
- This is the dominant cost — chunk count barely matters

**Key insight:** The BM25 scoring model itself is excellent (hybrid search quality is
"strikingly well" per James). The problem is purely the write path — per-term INSERTs
into growing B-tree indexes. The read/search path is fine.

**Fix ideas for V2:**
- Build inverted index data in memory first (Map<term, {docFreq, postings[]}>), then
  bulk-insert in one pass instead of one-term-at-a-time
- Consider FTS5 for storage (it has built-in bm25() ranking) but evaluate whether we
  can still compute true relative scores across hybrid sources
- Or keep custom tables but batch writes: accumulate all terms+postings across all
  chunks in a file, deduplicate in JS, then INSERT in bulk with a single prepared
  statement loop (avoids repeated ON CONFLICT lookups)

---

### 2. Database size is ~30x larger than expected

**Measured:** Workspace silo is 15GB for 23,505 chunks (2,938 files).

**Expected breakdown:**
- Chunk text: 23K chunks × ~500 tokens × 4 bytes ≈ 47MB
- Vectors: 23K × 384 dims × 4 bytes (float32) ≈ 36MB
- Inverted index (terms + postings): ~100-200MB
- Total expected: ~300-500MB

**15GB is pathological.** Likely causes:
- sqlite-vec virtual table overhead (stores vectors in shadow tables)
- Inverted index table bloat (postings table especially — 200K+ rows with indexes)
- WAL remnants baked into main DB from earlier 5GB WAL episode
- Page fragmentation from upsert/delete cycles (each upsert deletes then reinserts)

**Compression opportunities (James interested in all of these):**
- **Int8 quantized vectors:** sqlite-vec supports int8 (1 byte/dim vs 4 bytes).
  Snowflake Arctic Embed works well quantized. 4x vector size reduction.
- **zlib-compressed chunk text:** Compress before storing, decompress on read.
  Search uses vectors not raw text. Text compresses 3-5x. Loading doesn't need
  to be fast — search does.
- **VACUUM after initial indexing:** Would reclaim dead pages from upsert cycles.
- **Smaller inverted index:** Bulk-insert strategy would produce more compact tables
  than incremental ON CONFLICT upserts.

**James's constraint:** "Search has to be moderately fast — 2-3s for maybe 50k files.
Loading files doesn't have to be that fast."

---

### 3. Large file embedding blocks UI for minutes

**Measured:** Advanced Engineering Mathematics (2338 chunks):
- Total preparation: 202 seconds
- Embedding: 73 sequential batches of 32 chunks at ~2.8s each
- Flush to DB: 128 seconds (dominated by inverted index writes)

**Why UI freezes despite worker thread:**
- Embedding IS on a worker thread (WorkerEmbeddingProxy via worker_threads)
- Communication is truly async via message passing
- BUT individual batch round-trips take 2-3 seconds
- Windows flags "Not Responding" after ~5s without message pumping
- Variable text lengths mean some batches exceed the threshold

**Fix ideas:**
- Smaller embedding batch size (16 instead of 32) to reduce per-batch wall time
- More aggressive yielding during long files
- Show per-batch progress for files with >100 chunks
- Consider page-range segmentation: process 50-page chunks of a large PDF as
  separate "virtual files" to keep individual operations small

---

### 4. Single-file re-index during normal use is the worst UX impact

**Scenario (observed):** User edits `MOTOR SELECTION ANALYSIS.md` (15 chunks) in
Obsidian while another silo is indexing. Chokidar detects the change, queues a
reconcile for the workspace silo. When the queue clears, re-indexing that ONE file
takes **34,824ms** — the entire UI freezes for 35 seconds because of a single save.

**Why this is the most critical problem:**
- Initial bulk indexing is a one-time event users can tolerate
- "I saved a file and my app froze for 35 seconds" happens REPEATEDLY during normal use
- At 50K files the per-file cost would be 15-20+ seconds even with a smaller DB
- The sequential indexing queue compounds it — if another silo is reconciling, the
  user's file change is queued behind it, adding latency AND a freeze

**This scenario is the #1 motivation for V2's two biggest changes:**
1. **SQLite on worker thread** — the 35s write still happens, but UI doesn't freeze
2. **Batch inverted index writes** — reduces the 35s to <1s (bulk-insert instead of
   per-term INSERT OR CONFLICT into a large B-tree)

---

### 5. Post-reconcile operations are fast (NOT the problem)

**We spent multiple iterations trying to fix these — they were never the issue:**

| Operation                        | Measured Time |
|----------------------------------|--------------|
| syncDirectoriesWithDisk (236 dirs) | 1.5ms      |
| recomputeDirectoryCounts (236 dirs, 5 batches) | 60ms |
| WAL checkpoint(TRUNCATE)         | 3.4ms        |
| File removal phase (0 files)     | 0.0ms        |

These are all under 100ms. The "freeze at 100%" was actually large files being
processed near the end of the alphabetical file walk, not the post-processing.

---

### 6. Per-file overhead inside upsertFileInner

Beyond the inverted index, each file upsert also runs:
- `updateCorpusStats`: Full table scan `SELECT COUNT(*), AVG(token_count) FROM chunks`
  after EVERY file. Should be moved to end-of-batch or end-of-reconcile.
- `maintainDirectoriesOnUpsert`: LIKE scans on files/directories tables for each
  directory in the file's path. Also per-file. Could be deferred.

Both of these run inside the batch transaction, compounding the blocking.

---

### 7. Incremental WAL checkpointing works well

- `PRAGMA wal_checkpoint(PASSIVE)` after each batch flush keeps WAL small
- Final `PRAGMA wal_checkpoint(TRUNCATE)` is near-instant (3.4ms) when incremental
  checkpoints are running throughout
- Without incremental checkpoints, WAL grows to 5GB+ during heavy indexing
- This pattern should be kept in V2

---

### 8. Async I/O and yielding improvements (implemented, working)

Changes that helped UI responsiveness during indexing:
- `fs.readFileSync` → `await fsp.readFile` (async file reads in pipeline.ts)
- `setImmediate` yield every 5 pages during PDF extraction
- `setImmediate` yield every 5 files in reconcile loop
- Stage-based progress reporting (reading → extracting → chunking → embedding → flushing)
- These are all good patterns to keep in V2

---

## Storage Efficiency Analysis

### Current schema (per chunk stored)

```
chunks table:
  id            INTEGER PRIMARY KEY        (8 bytes)
  file_path     TEXT NOT NULL               (~40 bytes avg, stored key format "0:path/to/file.ts")
  chunk_index   INTEGER                    (8 bytes)
  section_path  TEXT (JSON array)          (~30 bytes avg)
  text          TEXT NOT NULL              (~2,000 bytes avg — this is the raw chunk content)
  location_hint TEXT (JSON)               (~30 bytes avg)
  metadata      TEXT (JSON, usually '{}') (~2 bytes)
  content_hash  TEXT                       (64 bytes — hex SHA-256)
  token_count   INTEGER                    (8 bytes)

vec_chunks virtual table (sqlite-vec):
  embedding     float[384]                 (1,536 bytes — 384 dims × 4 bytes/float32)

terms table (one row per unique term in corpus):
  term          TEXT PRIMARY KEY           (~10 bytes avg)
  doc_freq      INTEGER                    (8 bytes)

postings table (one row per unique term per chunk):
  term          TEXT NOT NULL              (~10 bytes avg — DUPLICATED from terms table)
  chunk_id      INTEGER NOT NULL           (8 bytes)
  term_freq     INTEGER                    (8 bytes)
  PRIMARY KEY (term, chunk_id)             + index on chunk_id
```

### Expected vs actual storage (workspace silo: 23,505 chunks, 2,938 files)

| Component          | Expected Size | Notes |
|--------------------|---------------|-------|
| Chunk text         | ~47 MB        | 23K × 2KB avg |
| Vectors (float32)  | ~34.5 MB      | 23K × 384 × 4 bytes |
| Inverted index     | ~200 MB       | ~7M postings rows (23K chunks × 300 terms) |
| Files/dirs/meta    | ~1 MB         | Small tables |
| **Expected total** | **~300 MB**   | |
| **Actual on disk** | **~15 GB**    | **50× expected** |

The 15GB → 300MB gap comes from: B-tree page fragmentation (delete-reinsert cycles
during upsert), sqlite-vec shadow table overhead, WAL remnants baked in from earlier
5GB WAL episode, and index bloat on the postings table compound primary key.

### Compression opportunities (priority order)

#### 1. VACUUM after bulk indexing — biggest single win
- `VACUUM` rebuilds the entire database file, eliminating all dead pages
- Would likely bring 15GB down to ~1-2GB immediately (reclaiming fragmentation)
- Should run once after initial indexing completes, then periodically
- Cost: takes time and temporarily doubles disk space, but a one-time operation
- Can also use `VACUUM INTO 'path.db'` to write a compacted copy

#### 2. Int8 quantized vectors — 4× vector storage reduction
- Current: `float[384]` = 1,536 bytes/vector
- With int8: `int8[384]` = 384 bytes/vector
- sqlite-vec supports `int8[N]` natively in vec0 table definitions
- Snowflake Arctic Embed models work well quantized (designed for it)
- Insert with `vec_quantize_int8(embedding, 'unit')` or quantize in JS before insert
- Saves ~27 MB for workspace silo; at 50K files the savings would be ~100MB+
- Quality impact: minimal for Arctic Embed (built for quantization)

#### 3. zlib-compressed chunk text — 3-5× text storage reduction
- Chunk text is only needed for display AFTER search returns results
- Search uses vectors (semantic) and inverted index (BM25), NOT raw text
- Compress with `zlib.deflateSync()` before INSERT, `inflateSync()` on read
- Store as BLOB instead of TEXT column
- ~47 MB → ~10-15 MB for workspace silo
- Decompression is ~1ms per chunk (negligible for result display)
- James's constraint: "Loading files doesn't have to be that fast" ✓

#### 4. Normalize postings table — eliminate term TEXT duplication
- Current: postings stores `term TEXT` — the full term string repeated per chunk
- Better: postings stores `term_id INTEGER` referencing terms table
- Saves ~10 bytes per posting × 7M postings = ~67 MB for workspace silo
- Also makes the B-tree index on postings much smaller (integer keys vs text)
- This directly helps the write-path performance too (smaller index = faster inserts)

#### 5. content_hash as BLOB — minor but clean
- SHA-256 as hex TEXT: 64 bytes per chunk
- SHA-256 as raw BLOB: 32 bytes per chunk
- Saves ~750 KB for workspace silo — small but free

#### 6. file_path normalization in chunks table
- Currently stores full stored key ("0:src/backend/store.ts") as TEXT per chunk
- Could normalize to file_id INTEGER referencing files table (already exists)
- Saves ~30 bytes per chunk × 23K = ~700 KB
- Also simplifies the DELETE/SELECT by file_path pattern

### Estimated storage after all optimizations

| Component              | Before    | After     | Reduction |
|------------------------|-----------|-----------|-----------|
| Chunk text             | 47 MB     | 12 MB     | 3-4×      |
| Vectors                | 34.5 MB   | 8.6 MB    | 4×        |
| Inverted index         | ~200 MB   | ~80 MB    | ~2.5×     |
| Hashes, paths, etc.    | ~5 MB     | ~2 MB     | ~2.5×     |
| **Data total**         | **~290 MB** | **~103 MB** | **~2.8×** |
| **After VACUUM**       | **~15 GB** | **~103 MB** | **~150×** |

Note: VACUUM is the dominant win because the current 15GB includes massive
fragmentation. The other optimizations reduce the fundamental data size.

---

## Architecture Notes for V2

### Current stack
- Electron + React + Vite (electron-forge plugin-vite)
- better-sqlite3 (synchronous, main thread)
- sqlite-vec (virtual table for vector search)
- Hand-rolled inverted index (terms + postings tables)
- ONNX embedding via worker_threads (WorkerEmbeddingProxy)
- chokidar file watcher

### V2 considerations
1. **Move all SQLite to a worker thread** — eliminates main-thread blocking entirely.
   The main thread only does IPC relay. All flushes, queries, and maintenance run off
   the event loop.
2. **Batch inverted index writes** — build term/posting maps in memory per-batch,
   then bulk-insert. Eliminates the ~6s per-file overhead.
3. **Keep BM25 hybrid scoring** — it's working excellently. Just fix the write path.
4. **Int8 vectors + compressed text** — massive DB size reduction with minimal
   quality impact.
5. **FTS5 evaluation** — could replace hand-rolled inverted index while still
   supporting bm25() scoring. Needs evaluation of whether true relative scores
   across hybrid sources are achievable.
6. **Large file segmentation** — process huge PDFs in page-range segments instead
   of as monolithic files.

### Performance targets (from James)
- Search: 2-3 seconds for 50K files
- Loading/reading: speed not critical
- Indexing: can take time, but UI must never feel frozen
- Resource usage: low CPU/RAM (currently good)

---

## Test Silo Data

Created `C:\Users\james\Documents\lodestone-test-silo\` with 217 files including:
- Large PDFs: Advanced Engineering Mathematics (~2338 chunks), Electricity and Magnetism (~325 chunks)
- Medium PDFs: research papers (30-80 chunks each)
- Small code files: TypeScript API routes (3-10 chunks each)
- Markdown files: various sizes
- Scanned PDFs (image-only, no text layer — error out correctly)

### Timing data from test silo indexing (full 217 files):

**Per-flush breakdown (BATCH_CHUNK_LIMIT=100):**

| Flush | Files | Chunks | Time (ms) | Per-file (s) |
|-------|-------|--------|-----------|-------------|
| #1    | 4     | 2,435  | 166,848   | 41.7 (dominated by 2338-chunk PDF) |
| #2    | 3     | 402    | 20,695    | 6.9  |
| #3    | 21    | 105    | 132,608   | 6.3  |
| #4    | 36    | 187    | 227,685   | 6.3  |
| #5    | 61    | 102    | 388,111   | 6.4  |
| #6    | 18    | 100    | 119,356   | 6.6  |
| #7    | 22    | 100    | 141,640   | 6.4  |
| #8    | 22    | 105    | 140,785   | 6.4  |
| #9    | 14    | 100    | 93,856    | 6.7  |
| #10   | 16    | 72     | 107,878   | 6.7  |

**Phase 6 totals (complete run):**
- Total time: 1,834,139ms (30.6 minutes) for 217 files
- Prepare (embed + extract): 294,257ms (16% of total)
- Flush (DB writes): 1,539,464ms (84% of total)
- WAL checkpoints: 346ms (<0.1%)
- **The flush/write path is 5.2× slower than all embedding and extraction combined.**

**Key observation:** Per-file cost is ~6.3-6.7 seconds and SLOWLY INCREASING (B-tree
depth growing). Chunk count is irrelevant — 1-chunk markdown files take the same time
as 93-chunk code files.

**Most extreme example:** Flush #5 had 61 files with only 102 total chunks but took
388 seconds (6.5 minutes). Compare flush #1: 4 files with 2,435 chunks took 167
seconds. Fewer files but 24x more chunks was FASTER — proving cost is per-file, not
per-chunk.

**B-tree scaling proof:** After the test silo finished (3,636 chunks), the workspace
silo (23,505 chunks) flushed a single changed file (`MOTOR SELECTION ANALYSIS.md`,
15 chunks) → **34,824ms**. That's 5× the per-file cost from the test silo, directly
attributable to larger B-tree indexes in the inverted index tables. This means the
problem gets WORSE as the database grows — a database with 50K files could have
per-file upsert costs of 15-20+ seconds.

**File preparation times (embedding-dominated):**
- Tiny files (1-3 chunks): 200-500ms
- Small code files (5-10 chunks): 500-700ms
- Medium PDFs (30-80 chunks): 2-6 seconds
- Large PDFs (300+ chunks): 25+ seconds
- Massive textbook (2338 chunks): 202 seconds

**Preparation is NOT the bottleneck** for small files — upsert is. A file that takes
400ms to prepare then takes 6,300ms to upsert.

**Post-reconcile operations (confirmed fast):**
- Test silo (35 dirs): Phase 8 total 2.9ms, WAL checkpoint 797ms
- Workspace silo (236 dirs): Phase 8 total 63ms, WAL checkpoint 3.4ms
- These are never the bottleneck. The 797ms WAL checkpoint for test-silo was higher
  because it had just written a lot of new data, but still sub-second.

---

## Files Modified During This Session

### Diagnostic instrumentation (can be removed or kept):
- `src/backend/reconcile.ts` — Phase timing logs, per-file slow-file detection, flush timing
- `src/backend/store.ts` — flushPreparedFiles transaction timing, recomputeDirectoryCounts batch timing
- `src/backend/silo-manager.ts` — Post-reconcile WAL checkpoint timing

### Functional changes (keep):
- `src/backend/reconcile.ts` — BATCH_CHUNK_LIMIT lowered to 100, incremental PASSIVE WAL checkpoints, setImmediate yields, stage-based progress
- `src/backend/pipeline.ts` — Async file reads, FileStage type, onStage callback
- `src/backend/extractors/pdf.ts` — setImmediate yield every 5 pages
- `src/backend/store.ts` — syncDirectoriesWithDisk split from recomputeDirectoryCounts (batched async)
- `src/backend/silo-manager.ts` — Yield before WAL checkpoint
- `src/renderer/components/SiloCard.tsx` — Stage label + filename display, batch chunk counter
- `src/shared/types.ts` — Extended reconcileProgress with fileStage, batchChunkLimit, etc.
