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

export interface LodestoneConfig {
  server_name: string;
  default_model_key: string;
  defaults: DefaultsConfig;
  silos: Record<string, SiloTomlConfig>;
}

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

const DEFAULT_CONFIG: LodestoneConfig = {
  server_name: 'lodestone',
  default_model_key: DEFAULT_MODEL,
  defaults: {
    indexed_file_extensions: DEFAULT_INDEX_EXTENSIONS,
    ignored_folder_patterns: DEFAULT_IGNORE_DIRS,
    ignored_file_patterns: DEFAULT_IGNORE_FILES,
    file_change_delay_seconds: DEFAULT_FILE_CHANGE_DELAY_SECONDS,
    edit_context_lines: DEFAULT_CONTEXT_LINES,
    max_activity_log_entries: DEFAULT_ACTIVITY_LOG_LIMIT,
  },
  silos: {},
};

type TomlObject = Record<string, unknown>;

export function loadLodestoneConfig(configPath: string): LodestoneConfig {
  const parsed = readTomlObject(configPath);

  return {
    server_name: stringField(parsed.server_name, DEFAULT_CONFIG.server_name),
    default_model_key: stringField(parsed.default_model_key, DEFAULT_CONFIG.default_model_key),
    defaults: parseDefaultsConfig(parsed.defaults),
    silos: parseSilosConfig(parsed.silos),
  };
}

export function saveLodestoneConfig(configPath: string, config: LodestoneConfig): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, stringify(config), 'utf-8');
}

export function createDefaultLodestoneConfig(): LodestoneConfig {
  return structuredClone(DEFAULT_CONFIG);
}

export function getDefaultLodestoneConfigPath(userDataDir: string): string {
  return path.join(userDataDir, 'config.toml');
}

export function lodestoneConfigFileExists(configPath: string): boolean {
  return fs.existsSync(configPath);
}

export function resolveSiloRuntimeConfig(
  siloName: string,
  silo: SiloTomlConfig,
  config: LodestoneConfig,
): ResolvedSiloConfig {
  return {
    name: siloName,
    indexedDirectories: silo.indexed_directories,
    indexDbPath: silo.index_db_path,
    indexedFileExtensions: silo.indexed_file_extensions ?? config.defaults.indexed_file_extensions,
    ignoredFolderPatterns: silo.ignored_folder_patterns ?? config.defaults.ignored_folder_patterns,
    ignoredFilePatterns: silo.ignored_file_patterns ?? config.defaults.ignored_file_patterns,
    embeddingModelKey: silo.embedding_model_key ?? config.default_model_key,
    fileChangeDelaySeconds: config.defaults.file_change_delay_seconds,
    maxActivityLogEntries: config.defaults.max_activity_log_entries,
    isStopped: silo.is_stopped === true,
    contentDescription: silo.content_description ?? '',
    accentColor: validateSiloColor(silo.accent_color),
    iconName: validateSiloIcon(silo.icon_name),
  };
}

function readTomlObject(configPath: string): TomlObject {
  const raw = fs.readFileSync(configPath, 'utf-8');
  return parse(raw) as TomlObject;
}

function parseDefaultsConfig(rawDefaults: unknown): DefaultsConfig {
  const defaults = objectField(rawDefaults);

  return {
    indexed_file_extensions: stringArrayField(
      defaults.indexed_file_extensions,
      DEFAULT_CONFIG.defaults.indexed_file_extensions,
    ),
    ignored_folder_patterns: stringArrayField(
      defaults.ignored_folder_patterns,
      DEFAULT_CONFIG.defaults.ignored_folder_patterns,
    ),
    ignored_file_patterns: stringArrayField(
      defaults.ignored_file_patterns,
      DEFAULT_CONFIG.defaults.ignored_file_patterns,
    ),
    file_change_delay_seconds: numberField(
      defaults.file_change_delay_seconds,
      DEFAULT_CONFIG.defaults.file_change_delay_seconds,
    ),
    edit_context_lines: numberField(
      defaults.edit_context_lines,
      DEFAULT_CONFIG.defaults.edit_context_lines,
    ),
    max_activity_log_entries: numberField(
      defaults.max_activity_log_entries,
      DEFAULT_CONFIG.defaults.max_activity_log_entries,
    ),
  };
}

function parseSilosConfig(rawSilos: unknown): Record<string, SiloTomlConfig> {
  const silos = objectField(rawSilos);

  return Object.fromEntries(
    Object.entries(silos).map(([name, rawSilo]) => [
      name,
      parseSiloTomlConfig(name, objectField(rawSilo)),
    ]),
  );
}

function parseSiloTomlConfig(name: string, silo: TomlObject): SiloTomlConfig {
  const indexedDirectories = stringArrayField(silo.indexed_directories);
  const indexDbPath = stringField(silo.index_db_path);

  if (indexedDirectories.length === 0) {
    throw new Error(`Silo "${name}" must have at least one indexed directory`);
  }
  if (indexDbPath.length === 0) {
    throw new Error(`Silo "${name}" must have an index_db_path`);
  }

  return {
    indexed_directories: indexedDirectories,
    index_db_path: indexDbPath,
    indexed_file_extensions: optionalStringArrayField(silo.indexed_file_extensions),
    ignored_folder_patterns: optionalStringArrayField(silo.ignored_folder_patterns),
    ignored_file_patterns: optionalStringArrayField(silo.ignored_file_patterns),
    embedding_model_key: optionalStringField(silo.embedding_model_key),
    is_stopped: silo.is_stopped === true ? true : undefined,
    content_description: optionalStringField(silo.content_description),
    accent_color: optionalStringField(silo.accent_color),
    icon_name: optionalStringField(silo.icon_name),
  };
}

function objectField(value: unknown): TomlObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as TomlObject) : {};
}

function stringField(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function optionalStringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringArrayField(value: unknown, fallback: string[] = []): string[] {
  return Array.isArray(value) ? (value as string[]) : fallback;
}

function optionalStringArrayField(value: unknown): string[] | undefined {
  return Array.isArray(value) ? (value as string[]) : undefined;
}

function numberField(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}
