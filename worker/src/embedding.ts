/**
 * Embedding service — Workers AI wrapper with EmbeddingGemma 300M task prefixes.
 *
 * EmbeddingGemma uses asymmetric prefixes for retrieval:
 *   - Documents: "title: {topic} | text: {body}"
 *   - Queries:   "task: search result | query: {text}"
 *
 * This mirrors the desktop embedDocument()/embedQuery() split in
 * src/backend/memory-manager.ts. Asymmetric embedding is critical for
 * retrieval quality — documents and queries occupy different regions of
 * the embedding space.
 */

const MODEL_ID = '@cf/google/embeddinggemma-300m' as const;

interface EmbeddingResponse {
  shape: number[];
  data: number[][];
}

/**
 * Embed a memory document using the document prefix.
 * Format: "title: {topic} | text: {body}"
 */
export async function embedDocument(ai: Ai, topic: string, body: string): Promise<number[]> {
  const input = `title: ${topic} | text: ${body}`;
  const response = await ai.run(MODEL_ID, { text: [input] }) as EmbeddingResponse;
  return response.data[0];
}

/**
 * Embed a search query using the query prefix.
 * Format: "task: search result | query: {text}"
 */
export async function embedQuery(ai: Ai, query: string): Promise<number[]> {
  const input = `task: search result | query: ${query}`;
  const response = await ai.run(MODEL_ID, { text: [input] }) as EmbeddingResponse;
  return response.data[0];
}
