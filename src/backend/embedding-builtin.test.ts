import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const tensor = {
    data: new Float32Array(384),
    dispose: vi.fn(),
  };
  const extractor = vi.fn().mockResolvedValue(tensor) as unknown as ReturnType<typeof vi.fn> & {
    dispose: ReturnType<typeof vi.fn>;
  };
  extractor.dispose = vi.fn();

  return {
    env: {} as Record<string, unknown>,
    extractor,
    pipeline: vi.fn().mockResolvedValue(extractor),
    tensor,
  };
});

vi.mock('@huggingface/transformers', () => ({
  env: mocks.env,
  pipeline: mocks.pipeline,
}));

describe('BuiltInEmbeddingService', () => {
  beforeEach(() => {
    mocks.pipeline.mockClear();
    mocks.extractor.mockClear();
    mocks.extractor.dispose.mockClear();
    mocks.tensor.dispose.mockClear();
    for (const key of Object.keys(mocks.env)) {
      delete mocks.env[key];
    }
  });

  it('loads Transformers from the supplied local model directory without enabling remote cache paths', async () => {
    const { BuiltInEmbeddingService } = await import('./embedding-builtin');
    const modelDir = 'C:\\lodestone\\resources\\models\\Snowflake\\snowflake-arctic-embed-s';
    const service = new BuiltInEmbeddingService(modelDir);

    await service.embed('hello');

    expect(mocks.pipeline).toHaveBeenCalledWith(
      'feature-extraction',
      modelDir,
      expect.objectContaining({
        dtype: 'q8',
        session_options: expect.objectContaining({
          interOpNumThreads: 1,
        }),
      }),
    );
    expect(mocks.env).not.toHaveProperty('cacheDir');
    expect(mocks.env).not.toHaveProperty('localModelPath');
    // Remote models are disabled so a missing bundled file fails offline
    // rather than attempting a network fetch.
    expect(mocks.env.allowRemoteModels).toBe(false);
  });
});
