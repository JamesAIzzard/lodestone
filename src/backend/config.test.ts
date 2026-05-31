import { describe, it, expect } from 'vitest';
import {
  loadLodestoneConfig,
  createDefaultLodestoneConfig,
  resolveSiloRuntimeConfig,
} from './config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpDir: string;

function writeConfig(contents: string): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-config-test-'));
  const p = path.join(tmpDir, 'config.toml');
  fs.writeFileSync(p, contents);
  return p;
}

describe('loadLodestoneConfig', () => {
  it('loads default config when file is missing', () => {
    const config = createDefaultLodestoneConfig();
    expect(config.server_name).toBe('lodestone');
  });

  it('ignores stale embedding-model fields from older configs without erroring', () => {
    // Lodestone used to support `default_model_key` and per-silo
    // `embedding_model_key`. The app now ships a single bundled model, so these
    // fields are no longer part of the config schema. An existing config.toml
    // that still carries them must load cleanly — the parser reads only named
    // fields, so the stale model keys are silently dropped on the next save.
    const p = writeConfig(`
server_name = "test"
default_model_key = "snowflake-arctic-embed-xs"

[silos.notes]
indexed_directories = ["/tmp/notes"]
index_db_path = "/tmp/notes.db"
embedding_model_key = "nomic-embed-text-v1.5"
`);
    const config = loadLodestoneConfig(p);

    expect(config.server_name).toBe('test');
    expect((config as unknown as Record<string, unknown>).default_model_key).toBeUndefined();
    expect(config.silos.notes).toBeDefined();
    expect(
      (config.silos.notes as unknown as Record<string, unknown>).embedding_model_key,
    ).toBeUndefined();

    // The silo still resolves to a usable runtime config without any model field.
    const resolved = resolveSiloRuntimeConfig('notes', config.silos.notes, config);
    expect(resolved.indexedDirectories).toEqual(['/tmp/notes']);
    expect((resolved as unknown as Record<string, unknown>).embeddingModelKey).toBeUndefined();
  });
});
