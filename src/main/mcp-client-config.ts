import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';

const LODESTONE_SERVER_NAME = 'lodestone-files';
const CODEX_STARTUP_TIMEOUT_SEC = 20;

export type McpClientId = 'claude-desktop' | 'claude-code' | 'codex-desktop';

export interface McpClientStatus {
  configPath: string;
  hasClient: boolean;
  isConfigured: boolean;
}

export interface McpClientConfigureResult {
  success: boolean;
  configPath: string;
  error?: string;
}

function readJsonObject(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {};

  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readTomlObject(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {};

  try {
    return parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not parse existing Codex config: ${message}`);
  }
}

export function getClaudeDesktopConfigPath(appDataDir: string): string {
  return path.join(appDataDir, 'Claude', 'claude_desktop_config.json');
}

export function getClaudeCodeConfigPath(homeDir: string): string {
  return path.join(homeDir, '.claude.json');
}

export function getCodexDesktopConfigPath(homeDir: string): string {
  return path.join(homeDir, '.codex', 'config.toml');
}

export function getMcpWrapperPath(options: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  return options.isPackaged
    ? path.join(options.resourcesPath, 'mcp-wrapper.js')
    : path.join(options.appPath, 'mcp-wrapper.js');
}

export function getClaudeDesktopStatus(configPath: string): McpClientStatus {
  const config = readJsonObject(configPath);
  const mcpServers = config.mcpServers as Record<string, unknown> | undefined;

  return {
    configPath,
    hasClient: fs.existsSync(path.dirname(configPath)),
    isConfigured: !!mcpServers?.[LODESTONE_SERVER_NAME],
  };
}

function configureJsonMcpClient(
  configPath: string,
  wrapperPath: string,
): McpClientConfigureResult {
  try {
    const config = readJsonObject(configPath);
    const mcpServers = (config.mcpServers as Record<string, unknown>) ?? {};
    config.mcpServers = {
      ...mcpServers,
      [LODESTONE_SERVER_NAME]: { command: 'node', args: [wrapperPath] },
    };

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return { success: true, configPath };
  } catch (err) {
    return {
      success: false,
      configPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function configureClaudeDesktop(
  configPath: string,
  wrapperPath: string,
): McpClientConfigureResult {
  return configureJsonMcpClient(configPath, wrapperPath);
}

export function getClaudeCodeStatus(configPath: string): McpClientStatus {
  const config = readJsonObject(configPath);
  const mcpServers = config.mcpServers as Record<string, unknown> | undefined;
  const claudeDir = path.join(path.dirname(configPath), '.claude');

  return {
    configPath,
    hasClient: fs.existsSync(configPath) || fs.existsSync(claudeDir),
    isConfigured: !!mcpServers?.[LODESTONE_SERVER_NAME],
  };
}

export function configureClaudeCode(
  configPath: string,
  wrapperPath: string,
): McpClientConfigureResult {
  return configureJsonMcpClient(configPath, wrapperPath);
}

export function getCodexDesktopStatus(configPath: string): McpClientStatus {
  try {
    const config = readTomlObject(configPath);
    const mcpServers = config.mcp_servers as Record<string, unknown> | undefined;

    return {
      configPath,
      hasClient: fs.existsSync(path.dirname(configPath)),
      isConfigured: !!mcpServers?.[LODESTONE_SERVER_NAME],
    };
  } catch {
    return {
      configPath,
      hasClient: fs.existsSync(path.dirname(configPath)),
      isConfigured: false,
    };
  }
}

export function configureCodexDesktop(
  configPath: string,
  wrapperPath: string,
): McpClientConfigureResult {
  try {
    const config = readTomlObject(configPath);
    const mcpServers = (config.mcp_servers as Record<string, unknown>) ?? {};
    config.mcp_servers = {
      ...mcpServers,
      [LODESTONE_SERVER_NAME]: {
        command: 'node',
        args: [wrapperPath],
        enabled: true,
        startup_timeout_sec: CODEX_STARTUP_TIMEOUT_SEC,
      },
    };

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, stringify(config), 'utf-8');
    return { success: true, configPath };
  } catch (err) {
    return {
      success: false,
      configPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
