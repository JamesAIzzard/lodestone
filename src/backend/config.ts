/**
 * TOML configuration file parsing and persistence.
 *
 * The config file defines the server settings, embedding defaults,
 * and per-silo directory/extension/model configuration.
 */

import { parse, stringify } from 'smol-toml';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MODEL } from './model-registry';
import {
  validateSiloColor,
  validateSiloIcon,
  type SiloColor,
  type SiloIconName,
} from '../shared/silo-appearance';
import {
  DEFAULT_ACTIVITY_LOG_LIMIT,
  DEFAULT_CONTEXT_LINES,
  DEFAULT_FILE_CHANGE_DELAY_SECONDS,
  DEFAULT_IGNORE_DIRS,
  DEFAULT_IGNORE_FILES,
} from '../shared/app-defaults';
import { DEFAULT_INDEX_EXTENSIONS } from '../shared/file-types';


export interface ServerConfig {
  name: string;
}

export interface EmbeddingsConfig {
  default_model_key: string;
}

export interface DefaultsConfig {
  indexed_file_extensions: string[];
  ignored_folder_patterns: string[];
  ignored_file_patterns: string[];
  file_change_delay_seconds: number;
  edit_context_lines: number;
  max_activity_log_entries: number;
}

export interface SiloTomlConfig {
  indexed_directories: string[];
  index_db_path: string;
  indexed_file_extensions?: string[];
  ignored_folder_patterns?: string[];
  ignored_file_patterns?: string[];
  embedding_model_key?: string;
  is_stopped?: boolean;
  content_description?: string;
  accent_color?: string;
  icon_name?: string;
}

export type SearchConfig = Record<string, never>;
// two-axis model — all scores are now transparent [0,1] values.

export interface LodestoneConfig {
  server: ServerConfig;
  embeddings: EmbeddingsConfig;
  defaults: DefaultsConfig;
  search: SearchConfig;
  silos: Record<string, SiloTomlConfig>;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: LodestoneConfig = {
  server: {
    name: 'lodestone',
  },
  embeddings: {
    default_model_key: DEFAULT_MODEL,
  },
  defaults: {
    indexed_file_extensions: DEFAULT_INDEX_EXTENSIONS,
    ignored_folder_patterns: DEFAULT_IGNORE_DIRS,
    ignored_file_patterns: DEFAULT_IGNORE_FILES,
    file_change_delay_seconds: DEFAULT_FILE_CHANGE_DELAY_SECONDS,
    edit_context_lines: DEFAULT_CONTEXT_LINES,
    max_activity_log_entries: DEFAULT_ACTIVITY_LOG_LIMIT,
  },
  search: {},
  silos: {},
};

// ── Load / Save ──────────────────────────────────────────────────────────────

/**
 * Load and parse the TOML configuration file.
 * Returns a typed config object with defaults applied for missing fields.
 */
export function loadConfig(configPath: string): LodestoneConfig {
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = parse(raw) as Record<string, unknown>;

  const server = (parsed.server ?? {}) as Partial<ServerConfig>;
  const embeddings = (parsed.embeddings ?? {}) as Partial<EmbeddingsConfig>;
  const defaults = (parsed.defaults ?? {}) as Partial<DefaultsConfig>;
  // search section is reserved but currently empty (weights removed in two-axis model)
  const silos = (parsed.silos ?? {}) as Record<string, unknown>;

  // Validate silos — each must have indexed directories and an index database path.
  const validatedSilos: Record<string, SiloTomlConfig> = {};
  for (const [name, raw] of Object.entries(silos)) {
    const silo = raw as Record<string, unknown>;
    if (!Array.isArray(silo.indexed_directories) || silo.indexed_directories.length === 0) {
      throw new Error(`Silo "${name}" must have at least one indexed directory`);
    }
    if (typeof silo.index_db_path !== 'string' || silo.index_db_path.length === 0) {
      throw new Error(`Silo "${name}" must have an index_db_path`);
    }
    validatedSilos[name] = {
      indexed_directories: silo.indexed_directories as string[],
      index_db_path: silo.index_db_path as string,
      indexed_file_extensions: Array.isArray(silo.indexed_file_extensions)
        ? (silo.indexed_file_extensions as string[])
        : undefined,
      ignored_folder_patterns: Array.isArray(silo.ignored_folder_patterns)
        ? (silo.ignored_folder_patterns as string[])
        : undefined,
      ignored_file_patterns: Array.isArray(silo.ignored_file_patterns)
        ? (silo.ignored_file_patterns as string[])
        : undefined,
      embedding_model_key:
        typeof silo.embedding_model_key === 'string' ? silo.embedding_model_key : undefined,
      is_stopped: silo.is_stopped === true ? true : undefined,
      content_description:
        typeof silo.content_description === 'string' ? silo.content_description : undefined,
      accent_color: typeof silo.accent_color === 'string' ? silo.accent_color : undefined,
      icon_name: typeof silo.icon_name === 'string' ? silo.icon_name : undefined,
    };
  }

  return {
    server: {
      name: typeof server.name === 'string' ? server.name : DEFAULT_CONFIG.server.name,
    },
    embeddings: {
      default_model_key:
        typeof embeddings.default_model_key === 'string'
          ? embeddings.default_model_key
          : DEFAULT_CONFIG.embeddings.default_model_key,
    },
    defaults: {
      indexed_file_extensions: Array.isArray(defaults.indexed_file_extensions)
        ? (defaults.indexed_file_extensions as string[])
        : DEFAULT_CONFIG.defaults.indexed_file_extensions,
      ignored_folder_patterns: Array.isArray(defaults.ignored_folder_patterns)
        ? (defaults.ignored_folder_patterns as string[])
        : DEFAULT_CONFIG.defaults.ignored_folder_patterns,
      ignored_file_patterns: Array.isArray(defaults.ignored_file_patterns)
        ? (defaults.ignored_file_patterns as string[])
        : DEFAULT_CONFIG.defaults.ignored_file_patterns,
      file_change_delay_seconds:
        typeof defaults.file_change_delay_seconds === 'number'
          ? defaults.file_change_delay_seconds
          : DEFAULT_CONFIG.defaults.file_change_delay_seconds,
      edit_context_lines:
        typeof defaults.edit_context_lines === 'number'
          ? defaults.edit_context_lines
          : DEFAULT_CONFIG.defaults.edit_context_lines,
      max_activity_log_entries:
        typeof defaults.max_activity_log_entries === 'number'
          ? defaults.max_activity_log_entries
          : DEFAULT_CONFIG.defaults.max_activity_log_entries,
    },
    search: {},
    silos: validatedSilos,
  };
}

/**
 * Save the configuration to a TOML file.
 * Creates parent directories if they don't exist.
 */
export function saveConfig(configPath: string, config: LodestoneConfig): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, stringify(config), 'utf-8');
}

/**
 * Return a fresh default config with no silos defined.
 */
export function createDefaultConfig(): LodestoneConfig {
  return structuredClone(DEFAULT_CONFIG);
}

// ── Config Path ──────────────────────────────────────────────────────────────

/**
 * Return the default config file path for the current platform.
 * Pass `userDataDir` explicitly so this module doesn't depend on Electron.
 * In Electron, call with app.getPath('userData').
 */
export function getDefaultConfigPath(userDataDir: string): string {
  return path.join(userDataDir, 'config.toml');
}

/**
 * Check whether a config file exists at the given path.
 */
export function configExists(configPath: string): boolean {
  return fs.existsSync(configPath);
}

// ── Resolved Silo Config ─────────────────────────────────────────────────────

/** A silo config with all defaults resolved (no optional fields). */
export interface ResolvedSiloConfig {
  name: string;
  indexedDirectories: string[];
  indexDbPath: string;
  indexedFileExtensions: string[];
  ignoredFolderPatterns: string[];
  ignoredFilePatterns: string[];
  embeddingModelKey: string;
  fileChangeDelaySeconds: number;
  maxActivityLogEntries: number;
  isStopped: boolean;
  contentDescription: string;
  accentColor: SiloColor;
  iconName: SiloIconName;
}

/**
 * Resolve a silo's effective configuration by merging silo-level
 * overrides with the global defaults.
 */
export function resolveSiloConfig(
  siloName: string,
  silo: SiloTomlConfig,
  config: LodestoneConfig,
): ResolvedSiloConfig {
  return {
    name: siloName,
    indexedDirectories: silo.indexed_directories,
    indexDbPath: silo.index_db_path,
    indexedFileExtensions: silo.indexed_file_extensions ?? config.defaults.indexed_file_extensions,
    ignoredFolderPatterns:
      silo.ignored_folder_patterns ?? config.defaults.ignored_folder_patterns,
    ignoredFilePatterns: silo.ignored_file_patterns ?? config.defaults.ignored_file_patterns,
    embeddingModelKey: silo.embedding_model_key ?? config.embeddings.default_model_key,
    fileChangeDelaySeconds: config.defaults.file_change_delay_seconds,
    maxActivityLogEntries: config.defaults.max_activity_log_entries,
    isStopped: silo.is_stopped === true,
    contentDescription: silo.content_description ?? '',
    accentColor: validateSiloColor(silo.accent_color),
    iconName: validateSiloIcon(silo.icon_name),
  };
}
