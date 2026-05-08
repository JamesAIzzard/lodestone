import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedSiloConfig } from './config';
import type { EmbeddingService } from './embedding';
import { IndexingQueue } from './indexing-queue';
import { SiloManager } from './silo-manager';

function makeConfig(indexDbPath: string): ResolvedSiloConfig {
  return {
    name: 'bad-model',
    indexedDirectories: [os.tmpdir()],
    indexDbPath,
    indexedFileExtensions: ['.md'],
    ignoredFolderPatterns: [],
    ignoredFilePatterns: [],
    embeddingModelKey: 'nomic-embed-text',
    fileChangeDelaySeconds: 1,
    maxActivityLogEntries: 200,
    isStopped: false,
    contentDescription: '',
    accentColor: 'blue',
    iconName: 'database',
  };
}

function makeFailingEmbeddingService(): EmbeddingService {
  return {
    dimensions: 384,
    modelName: 'bad',
    maxTokens: 512,
    chunkTokens: 512,
    embed: async () => [],
    embedBatch: async () => [],
    ensureReady: async () => {
      throw new Error(
        'Unknown embedding model "nomic-embed-text". Available models: snowflake-arctic-embed-xs.',
      );
    },
    dispose: async () => undefined,
  };
}

describe('SiloManager startup', () => {
  it('surfaces embedding startup failures in silo status', async () => {
    const manager = new SiloManager(
      makeConfig(path.join(os.tmpdir(), 'lodestone-bad-model-test.db')),
      makeFailingEmbeddingService(),
      os.tmpdir(),
      new IndexingQueue(),
    );

    manager.loadWaitingStatus();

    await expect(manager.start()).rejects.toThrow('Unknown embedding model "nomic-embed-text"');

    const status = await manager.getStatus();
    expect(status.watcherState).toBe('error');
    expect(status.errorMessage).toContain('Unknown embedding model "nomic-embed-text"');
  });
});
