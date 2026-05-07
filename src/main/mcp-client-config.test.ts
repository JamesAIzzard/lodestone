import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import {
  configureClaudeDesktop,
  configureCodexDesktop,
  getClaudeDesktopStatus,
  getCodexDesktopStatus,
} from './mcp-client-config';

interface ParsedCodexConfig {
  model?: unknown;
  mcp_servers: Record<
    string,
    {
      url?: unknown;
      command?: unknown;
      args?: unknown;
      enabled?: unknown;
      startup_timeout_sec?: unknown;
      tools?: Record<string, { approval_mode?: unknown }>;
    }
  >;
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-mcp-client-config-'));
}

describe('mcp client config', () => {
  it('adds Lodestone to Claude Desktop config without removing existing MCP servers', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'Claude', 'claude_desktop_config.json');
    const wrapperPath = 'C:\\Lodestone\\mcp-wrapper.js';
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          existing: { command: 'node', args: ['existing.js'] },
        },
      }),
      'utf-8',
    );

    const result = configureClaudeDesktop(configPath, wrapperPath);

    expect(result).toEqual({ success: true, configPath });
    expect(getClaudeDesktopStatus(configPath)).toEqual({
      configPath,
      hasClient: true,
      isConfigured: true,
    });
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(parsed.mcpServers.existing).toEqual({ command: 'node', args: ['existing.js'] });
    expect(parsed.mcpServers['lodestone-files']).toEqual({
      command: 'node',
      args: [wrapperPath],
    });
  });

  it('adds Lodestone to Codex config.toml without removing existing settings', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, '.codex', 'config.toml');
    const wrapperPath = 'C:\\Lodestone\\mcp-wrapper.js';
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        'model = "gpt-5.5"',
        '',
        '[mcp_servers.existing]',
        'url = "https://example.com/mcp"',
        '',
        '[mcp_servers.existing.tools.search]',
        'approval_mode = "approve"',
      ].join('\n'),
      'utf-8',
    );

    const result = configureCodexDesktop(configPath, wrapperPath);

    expect(result).toEqual({ success: true, configPath });
    expect(getCodexDesktopStatus(configPath)).toEqual({
      configPath,
      hasClient: true,
      isConfigured: true,
    });
    const parsed = parse(fs.readFileSync(configPath, 'utf-8')) as unknown as ParsedCodexConfig;
    expect(parsed.model).toBe('gpt-5.5');
    expect(parsed.mcp_servers.existing.url).toBe('https://example.com/mcp');
    expect(parsed.mcp_servers.existing.tools.search.approval_mode).toBe('approve');
    expect(parsed.mcp_servers['lodestone-files']).toEqual({
      command: 'node',
      args: [wrapperPath],
      enabled: true,
      startup_timeout_sec: 20,
    });
  });

  it('does not overwrite malformed Codex config.toml', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, '.codex', 'config.toml');
    const raw = '[mcp_servers.bad\ncommand = "node"';
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, raw, 'utf-8');

    const result = configureCodexDesktop(configPath, 'C:\\Lodestone\\mcp-wrapper.js');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not parse existing Codex config');
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(raw);
  });
});
