/**
 * Unified Signal interface for Lodestone search.
 *
 * Every signal produces Map<storedKey, number> — file-level scores in [0, 1].
 * Chunk-level scoring happens internally where needed (semantic, BM25);
 * the composition layer only sees file-level scores.
 */

import type { SiloDatabase } from '../store/types';
import type { LocationHint } from '../../shared/types';

// ── Hint ────────────────────────────────────────────────────────────────────

/** Lightweight metadata about where/why a file matched, without chunk text. */
export interface SignalHint {
  /** Location of the best-matching chunk within the source file. */
  locationHint?: LocationHint;
  /** Section path of best-matching chunk (e.g. ["## Heading", "### Sub"]). */
  sectionPath?: string[];
  /** Chunk-level score from this signal (used for multi-chunk ranking). */
  score?: number;
}

// ── Context ─────────────────────────────────────────────────────────────────

/** Everything a signal needs to produce its scores. */
export interface SignalContext {
  /** Silo database handle. */
  db: SiloDatabase;
  /** Raw search query string. */
  query: string;
  /** Pre-computed query embedding vector (empty for bm25/regex modes). */
  queryVector: number[];
  /** Tokenised query (lowercased tokens). */
  queryTokens: string[];
  /** Compiled glob regex for filePattern filtering, or null. */
  filePatternRe: RegExp | null;
  /** Stored-key prefix for startPath filtering, or undefined. */
  startPath?: string;
  /** Maximum file-level results expected (signals can use for fan-out). */
  maxResults: number;
  /** Regex flags for regex mode. */
  regexFlags?: string;
}

// ── Signal ──────────────────────────────────────────────────────────────────

/** Output of a signal: per-file scores and per-file hints. */
export interface SignalResult {
  /** Stored key → [0, 1] score. */
  scores: Map<string, number>;
  /** Stored key → hint for this signal (best chunk location etc.). */
  hints: Map<string, SignalHint>;
  /** Stored key → all significant chunk hints for this signal (for multi-chunk display). */
  allHints?: Map<string, SignalHint[]>;
}

/** A scoring signal that produces file-level scores and hints. */
export interface Signal {
  /** Unique signal name (appears in score labels and UI). */
  name: string;
  /** Score all files in a silo, returning file-level scores and hints. */
  scoreAll(ctx: SignalContext): SignalResult;
}
