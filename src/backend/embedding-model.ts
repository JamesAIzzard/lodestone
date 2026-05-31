/**
 * The single embedding model used by Lodestone.
 *
 * There is no registry and no user-facing model choice — every silo uses this
 * one model. The model files are vendored under resources/models and loaded
 * from that local directory at runtime.
 *
 * The `key` is written into each index's `meta` table. Changing the model
 * means changing `key`, which invalidates every existing index.
 */

export interface EmbeddingModel {
  /** Stable identifier written to index metadata and checked by peekIndexState. */
  key: string;
  /** Human-readable name for display. */
  displayName: string;
  /** Vector dimensionality. */
  dimensions: number;
  /** Maximum tokens the model can process (used for max_length/truncation in ONNX). */
  maxTokens: number;
  /** Target chunk size for the chunker pipeline — typically much smaller than maxTokens. */
  chunkTokens: number;
  /** Prefix prepended to query text before encoding (empty if none). */
  queryPrefix: string;
  /** Prefix prepended to document text before encoding (empty if none). */
  documentPrefix: string;
  /** ONNX quantization level. */
  dtype: string;
  /** Concise, path-safe identifier ([a-z0-9-]) used when auto-generating DB filenames. */
  pathSafeId: string;
}

export const EMBEDDING_MODEL: EmbeddingModel = {
  key: 'snowflake-arctic-embed-s',
  displayName: 'Snowflake Arctic Embed S',
  dimensions: 384,
  maxTokens: 512,
  chunkTokens: 512,
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
  documentPrefix: '',
  dtype: 'q8',
  pathSafeId: 'arctic-s',
};
