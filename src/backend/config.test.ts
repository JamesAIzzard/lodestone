import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDefaultConfig, loadConfig, resolveSiloConfig } from './config';
import { DEFAULT_INDEX_EXTENSIONS } from '../shared/file-types';

describe('config defaults', () => {
  it('uses the shared file type registry for default extensions', () => {
    expect(createDefaultConfig().defaults.indexed_file_extensions).toEqual(
      DEFAULT_INDEX_EXTENSIONS,
    );
  });

  it('uses explicit default keys for configurable app behavior', () => {
    const config = createDefaultConfig();

    expect(config.embeddings.default_model_key).toBeTypeOf('string');
    expect(config.defaults.file_change_delay_seconds).toBe(10);
    expect(config.defaults.ignored_folder_patterns).toEqual([
      '.*',
      '_*',
      'node_modules',
      'dist',
      'build',
    ]);
    expect(config.defaults.ignored_file_patterns).toEqual(['.*', 'Thumbs.db']);
    expect(config.defaults.edit_context_lines).toBe(10);
    expect(config.defaults.max_activity_log_entries).toBe(2000);
  });

  it('loads the clearer default keys from TOML', () => {
    const config = loadConfig(
      writeTempConfig(`
[embeddings]
default_model_key = "snowflake-arctic-embed-xs"

[defaults]
indexed_file_extensions = [".md", ".txt"]
ignored_folder_patterns = ["node_modules"]
ignored_file_patterns = ["Thumbs.db"]
file_change_delay_seconds = 3
edit_context_lines = 8
max_activity_log_entries = 1234
`),
    );

    expect(config.embeddings.default_model_key).toBe('snowflake-arctic-embed-xs');
    expect(config.defaults.indexed_file_extensions).toEqual(['.md', '.txt']);
    expect(config.defaults.ignored_folder_patterns).toEqual(['node_modules']);
    expect(config.defaults.ignored_file_patterns).toEqual(['Thumbs.db']);
    expect(config.defaults.file_change_delay_seconds).toBe(3);
    expect(config.defaults.edit_context_lines).toBe(8);
    expect(config.defaults.max_activity_log_entries).toBe(1234);
  });

  it('loads clearer per-silo keys from TOML', () => {
    const config = loadConfig(
      writeTempConfig(`
[embeddings]
default_model_key = "snowflake-arctic-embed-xs"

[silos.docs]
indexed_directories = ["C:\\\\docs"]
index_db_path = "docs.db"
indexed_file_extensions = [".md"]
ignored_folder_patterns = ["node_modules"]
ignored_file_patterns = ["Thumbs.db"]
embedding_model_key = "nomic-embed-text-v1.5"
is_stopped = true
content_description = "Documentation and notes"
accent_color = "emerald"
icon_name = "book-open"
`),
    );

    expect(config.silos.docs).toEqual({
      indexed_directories: ['C:\\docs'],
      index_db_path: 'docs.db',
      indexed_file_extensions: ['.md'],
      ignored_folder_patterns: ['node_modules'],
      ignored_file_patterns: ['Thumbs.db'],
      embedding_model_key: 'nomic-embed-text-v1.5',
      is_stopped: true,
      content_description: 'Documentation and notes',
      accent_color: 'emerald',
      icon_name: 'book-open',
    });

    expect(resolveSiloConfig('docs', config.silos.docs, config)).toMatchObject({
      name: 'docs',
      indexedDirectories: ['C:\\docs'],
      indexDbPath: 'docs.db',
      indexedFileExtensions: ['.md'],
      ignoredFolderPatterns: ['node_modules'],
      ignoredFilePatterns: ['Thumbs.db'],
      embeddingModelKey: 'nomic-embed-text-v1.5',
      isStopped: true,
      contentDescription: 'Documentation and notes',
      accentColor: 'emerald',
      iconName: 'book-open',
    });
  });
});

function writeTempConfig(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-config-test-'));
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, contents, 'utf-8');
  return configPath;
}
