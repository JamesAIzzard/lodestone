# Cross-Silo Score Calibration — Implementation Plan

## Problem
RRF scores are rank-based: the top result in every silo scores ~1.0 regardless of actual
relevance. When merging across silos, irrelevant silos compete equally with relevant ones.

## Strategy
Multiply each result's RRF score by its best raw cosine similarity (converted from distance).
This "calibrates" the score — a rank-1 result in a silo where nothing matches well (cosine ~0.2)
becomes 0.2 instead of 1.0, while a rank-1 result in a strongly-matching silo (cosine ~0.9)
stays at 0.9.

Raw cosine similarity is broadly comparable across embedding models (0.15 = weak, 0.85 = strong),
even if the absolute scale isn't perfectly calibrated. This is sufficient to prevent clearly
irrelevant silos from dominating results.

## Changes

### 1. `src/backend/store.ts` — Surface raw cosine similarity

**Type: `SiloSearchResult`** (line 33)
- Add `bestVecSimilarity: number` field

**Function: `hybridSearchSilo`** (line 264)
- After building `vecRankMap`, also build `vecSimMap: Map<number, number>` mapping
  chunk rowid → cosine similarity (`1 - distance / 2`)
- Pass `vecSimMap` to `aggregateByFileRrf`

**Function: `aggregateByFileRrf`** (line 569)
- Accept new parameter `vecSimMap: Map<number, number>`
- Track `bestVecSim` per file (best cosine similarity among the file's chunks that had vec matches)
- For files with no vector match (FTS-only), default to 0.5 — exact keyword matches
  are a strong relevance signal even without semantic backing
- Return `bestVecSimilarity` in each `SiloSearchResult`

### 2. `src/shared/types.ts` — Add field to IPC type

**Interface: `SearchResult`** (line 45)
- Add optional `bestVecSimilarity?: number`

### 3. `src/main.ts` — Calibrate at merge time

**IPC handler: `silos:search`** (line 392)
- When mapping `SiloSearchResult` → `SearchResult`, include `bestVecSimilarity`
- Change the sort to use calibrated score: `score * bestVecSimilarity`
- Store calibrated score as the result's `score` field so renderer displays the right value

### 4. `src/backend/mcp-server.ts` — Same calibration

**Search tool handler** (line ~195)
- `manager.search()` calls `hybridSearchSilo` internally, so results already have `bestVecSimilarity`
- Apply same calibration: `score * bestVecSimilarity` before sorting

### 5. `src/backend/silo-manager.ts` — No changes needed

Both `search()` and `searchWithVector()` just pass through from `hybridSearchSilo`,
which will now return the new field automatically.

### 6. `src/renderer/views/SearchView.tsx` — No changes needed

Scores are already displayed as percentages via `scorePercent()`. The calibrated scores
will be lower but more meaningful. No UI changes required.

## Edge Cases

- **FTS-only matches** (no vector hit): default bestVecSimilarity to 0.5.
  Rationale: literal keyword match is a strong relevance signal.
- **Single-silo search**: calibration still applies. Even within a silo, the calibrated
  score is more meaningful than raw RRF (which is purely rank-based).
- **Cross-model silos**: cosine similarity is broadly representative across models.
  Not perfectly calibrated, but sufficient to suppress clearly irrelevant results.
