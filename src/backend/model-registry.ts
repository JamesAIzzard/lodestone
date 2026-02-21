/**
 * Model Registry — static metadata for all known embedding models.
 *
 * Maps model identifiers (used in config, meta.json, and UI) to their
 * technical configuration: HuggingFace model ID, vector dimensions,
 * context window, and query/document prefixes.
 *
 * Two models are bundled with the application:
 *   - snowflake-arctic-embed-xs (default) — 384-dim, 512 tokens, ~22MB
 *   - nomic-embed-text-v1.5            — 768-dim, 8192 tokens, ~131MB
 *
 * The registry also serves as the single source of truth for which models
 * are available without Ollama, and what prefixes each model requires.
 */

// ── Model Definition ─────────────────────────────────────────────────────────

export interface ModelDefinition {
  /** Human-readable display name */
  displayName: string;
  /** HuggingFace model ID for Transformers.js */
  hfModelId: string;
  /** Vector dimensionality */
  dimensions: number;
  /** Maximum tokens the model can technically process (used for max_length/truncation in ONNX) */
  maxTokens: number;
  /**
   * Target chunk size for the chunker pipeline. Typically much less than maxTokens —
   * smaller chunks improve retrieval precision and reduce peak ONNX memory.
   * For nomic-embed-text-v1.5, maxTokens is 8192 but 512-token chunks work better.
   */
  chunkTokens: number;
  /** Prefix to prepend to query text before encoding (empty string if none) */
  queryPrefix: string;
  /** Prefix to prepend to document text before encoding (empty string if none) */
  documentPrefix: string;
  /** Whether this model ships with the Electron bundle */
  bundled: boolean;
  /** ONNX quantization level */
  dtype: string;
}

// ── Registry ─────────────────────────────────────────────────────────────────

/**
 * All known built-in embedding models, keyed by their config identifier.
 *
 * The key is what appears in config.toml (`embeddings.model` or `silos.*.model`)
 * and in `meta.json` for mismatch detection. It must be stable across versions.
 */
export const MODEL_REGISTRY: Record<string, ModelDefinition> = {
  'snowflake-arctic-embed-xs': {
    displayName: 'Arctic Embed XS (22MB, 384-dim)',
    hfModelId: 'Snowflake/snowflake-arctic-embed-xs',
    dimensions: 384,
    maxTokens: 512,
    chunkTokens: 512,
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    documentPrefix: '',
    bundled: true,
    dtype: 'q8',
  },
  'nomic-embed-text-v1.5': {
    displayName: 'Nomic Embed v1.5 (131MB, 768-dim)',
    hfModelId: 'nomic-ai/nomic-embed-text-v1.5',
    dimensions: 768,
    maxTokens: 8192,  // model's technical limit — kept for truncation safety
    chunkTokens: 512, // target chunk size — 8192 causes huge ONNX tensors and poor retrieval precision
    queryPrefix: 'search_query: ',
    documentPrefix: 'search_document: ',
    bundled: true,
    dtype: 'q8',
  },
};

/**
 * The default model for new installations and new silos.
 * This must be a key in MODEL_REGISTRY.
 */
export const DEFAULT_MODEL = 'snowflake-arctic-embed-xs';

/**
 * Legacy model identifier — used to detect indexes built with the Phase 2 model.
 * When encountered in meta.json, the system knows this index needs migration.
 */
export const LEGACY_MODEL = 'all-MiniLM-L6-v2';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Look up a model's definition by its identifier.
 * Returns undefined for Ollama models (which aren't in the registry).
 */
export function getModelDefinition(modelId: string): ModelDefinition | undefined {
  return MODEL_REGISTRY[modelId];
}

/**
 * Get all bundled model identifiers.
 */
export function getBundledModelIds(): string[] {
  return Object.entries(MODEL_REGISTRY)
    .filter(([, def]) => def.bundled)
    .map(([id]) => id);
}

/**
 * Check if a model identifier refers to a built-in (bundled) model.
 * Ollama models are not built-in.
 */
export function isBuiltInModel(modelId: string): boolean {
  return modelId in MODEL_REGISTRY;
}

/**
 * Resolve the legacy 'built-in' alias to the actual default model name.
 * This handles config files from Phase 2 that use 'built-in' as the model name.
 */
export function resolveModelAlias(modelId: string): string {
  if (modelId === 'built-in') return DEFAULT_MODEL;
  return modelId;
}
