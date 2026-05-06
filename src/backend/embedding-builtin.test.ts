import { describe, expect, it } from 'vitest';
import { BuiltInEmbeddingService } from './embedding-builtin';

describe('BuiltInEmbeddingService', () => {
  it('rejects unknown model ids instead of falling back to the default model', () => {
    expect(() => new BuiltInEmbeddingService('nomic-embed-text', 'unused-cache')).toThrow(
      /Unknown embedding model "nomic-embed-text"/,
    );
  });
});
