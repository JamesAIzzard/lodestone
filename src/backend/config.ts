/**
 * TOML configuration file parsing and persistence.
 *
 * The config file defines the server settings, embedding defaults,
 * and per-silo directory/extension/model configuration.
 */

import { parse, stringify } from 'smol-toml';
import fs from 'node:fs';
import path from 'node:path';
import { resolveModelAlias, DEFAULT_MODEL } from './model-registry';
import { validateSiloColor, validateSiloIcon, type SiloColor, type SiloIconName } from '../shared/silo-appearance';

// ── Config Types ─────────────────────────────────────────────────────────────

export interface ServerConfig {
  name: string;
}

export interface EmbeddingsConfig {
  /** Default embedding model: a registry key (e.g. 'snowflake-arctic-embed-xs')
   *  or an Ollama model name. Legacy 'built-in' alias is still accepted. */
  model: string;
  /** Ollama base URL — only used when the model is served via Ollama */
  ollama_url: string;
}

export interface DefaultsConfig {
  /** Debounce interval in seconds for file watcher events */
  debounce: number;
  /** Default file extensions to index */
  extensions: string[];
  /** Default folder ignore patterns (matched against directory basenames) */
  ignore: string[];
  /** Default file ignore patterns (matched against file basenames) */
  ignore_files: string[];
}

export interface SiloTomlConfig {
  directories: string[];
  db_path: string;
  extensions?: string[];
  ignore?: string[];
  ignore_files?: string[];
  model?: string;
  sleeping?: boolean;
  /** Human-readable description of what this silo contains (for MCP tool routing) */
  description?: string;
  /** Named colour key from the palette (e.g. 'blue', 'emerald') */
  color?: string;
  /** Lucide icon name in kebab-case (e.g. 'database', 'book-open') */
  icon?: string;
}

export interface LodestoneConfig {
  server: ServerConfig;
  embeddings: EmbeddingsConfig;
  defaults: DefaultsConfig;
  silos: Record<string, SiloTomlConfig>;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: LodestoneConfig = {
  server: {
    name: 'lodestone',
  },
  embeddings: {
    model: DEFAULT_MODEL,
    ollama_url: 'http://localhost:11434',
  },
  defaults: {
    debounce: 2.0,
    extensions: [
      '.md', '.txt',
      '.ts', '.tsx', '.js', '.jsx',
      '.py', '.rs', '.go', '.java',
      '.c', '.h', '.cpp', '.hpp',
      '.cs', '.rb', '.swift', '.kt',
    ],
    ignore: ['.git', '__pycache__', 'node_modules', '.obsidian', 'dist', 'build', '.next'],
    ignore_files: ['.DS_Store', 'Thumbs.db'],
  },
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
  const silos = (parsed.silos ?? {}) as Record<string, unknown>;

  // Validate silos — each must have directories and db_path
  const validatedSilos: Record<string, SiloTomlConfig> = {};
  for (const [name, raw] of Object.entries(silos)) {
    const silo = raw as Record<string, unknown>;
    if (!Array.isArray(silo.directories) || silo.directories.length === 0) {
      throw new Error(`Silo "${name}" must have at least one directory`);
    }
    if (typeof silo.db_path !== 'string' || silo.db_path.length === 0) {
      throw new Error(`Silo "${name}" must have a db_path`);
    }
    validatedSilos[name] = {
      directories: silo.directories as string[],
      db_path: silo.db_path as string,
      extensions: Array.isArray(silo.extensions) ? silo.extensions as string[] : undefined,
      ignore: Array.isArray(silo.ignore) ? silo.ignore as string[] : undefined,
      ignore_files: Array.isArray(silo.ignore_files) ? silo.ignore_files as string[] : undefined,
      model: typeof silo.model === 'string' ? silo.model : undefined,
      sleeping: silo.sleeping === true ? true : undefined,
      description: typeof silo.description === 'string' ? silo.description : undefined,
      color: typeof silo.color === 'string' ? silo.color : undefined,
      icon: typeof silo.icon === 'string' ? silo.icon : undefined,
    };
  }

  return {
    server: {
      name: typeof server.name === 'string' ? server.name : DEFAULT_CONFIG.server.name,
    },
    embeddings: {
      model: typeof embeddings.model === 'string' ? embeddings.model : DEFAULT_CONFIG.embeddings.model,
      ollama_url: typeof embeddings.ollama_url === 'string' ? embeddings.ollama_url : DEFAULT_CONFIG.embeddings.ollama_url,
    },
    defaults: {
      debounce: typeof defaults.debounce === 'number' ? defaults.debounce : DEFAULT_CONFIG.defaults.debounce,
      extensions: Array.isArray(defaults.extensions) ? defaults.extensions as string[] : DEFAULT_CONFIG.defaults.extensions,
      ignore: Array.isArray(defaults.ignore) ? defaults.ignore as string[] : DEFAULT_CONFIG.defaults.ignore,
      ignore_files: Array.isArray(defaults.ignore_files) ? defaults.ignore_files as string[] : DEFAULT_CONFIG.defaults.ignore_files,
    },
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
  directories: string[];
  dbPath: string;
  extensions: string[];
  ignore: string[];
  ignoreFiles: string[];
  model: string;
  debounce: number;
  sleeping: boolean;
  /** Human-readable description for MCP tool routing */
  description: string;
  /** Palette colour for UI accent (validated, always present) */
  color: SiloColor;
  /** Lucide icon name for UI display (validated, always present) */
  icon: SiloIconName;
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
  // Resolve 'built-in' alias → actual default model key for backward compat
  const rawModel = silo.model ?? config.embeddings.model;
  return {
    name: siloName,
    directories: silo.directories,
    dbPath: silo.db_path,
    extensions: silo.extensions ?? config.defaults.extensions,
    ignore: silo.ignore ?? config.defaults.ignore,
    ignoreFiles: silo.ignore_files ?? config.defaults.ignore_files,
    model: resolveModelAlias(rawModel),
    debounce: config.defaults.debounce,
    sleeping: silo.sleeping === true,
    description: silo.description ?? '',
    color: validateSiloColor(silo.color),
    icon: validateSiloIcon(silo.icon),
  };
}
