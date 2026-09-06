import { describe, it, expect } from 'vitest';
import {
  loadLodestoneConfig,
  saveLodestoneConfig,
  createDefaultLodestoneConfig,
  resolveSiloRuntimeConfig,
  mailDataDir,
} from './config';
import { accountHash, accountUid } from './mail/identity';
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

  it('loads an optional LLM instructions note path', () => {
    const p = writeConfig(`
server_name = "test"
llm_instructions_note_path = "C:\\\\Notes\\\\LLM User Instructions.md"
`);

    expect(loadLodestoneConfig(p).llm_instructions_note_path).toBe(
      'C:\\Notes\\LLM User Instructions.md',
    );
  });

  it('leaves the LLM instructions note unset by default', () => {
    expect(createDefaultLodestoneConfig().llm_instructions_note_path).toBeUndefined();
  });

  it('round-trips the selected LLM instructions note path', () => {
    const p = writeConfig('server_name = "test"');
    const config = loadLodestoneConfig(p);
    config.llm_instructions_note_path = 'C:\\Notes\\LLM User Instructions.md';

    saveLodestoneConfig(p, config);

    expect(loadLodestoneConfig(p).llm_instructions_note_path).toBe(
      'C:\\Notes\\LLM User Instructions.md',
    );
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

  it('round-trips silo policies and resolves their runtime defaults', () => {
    const p = writeConfig(`
server_name = "test"

[silos.mail]
indexed_directories = ["/tmp/mail"]
index_db_path = "/tmp/mail.db"
read_only = true
managed_by = "mail:abc123"
supports_path_search = false
`);
    const config = loadLodestoneConfig(p);
    const resolved = resolveSiloRuntimeConfig('mail', config.silos.mail, config);

    expect(resolved.readOnly).toBe(true);
    expect(resolved.managedBy).toBe('mail:abc123');
    expect(resolved.supportsPathSearch).toBe(false);

    saveLodestoneConfig(p, config);
    expect(loadLodestoneConfig(p).silos.mail).toMatchObject({
      read_only: true,
      managed_by: 'mail:abc123',
      supports_path_search: false,
    });
  });

  it('defaults silo policies without writing absent keys', () => {
    const p = writeConfig(`
server_name = "test"

[silos.notes]
indexed_directories = ["/tmp/notes"]
index_db_path = "/tmp/notes.db"
`);
    const config = loadLodestoneConfig(p);
    const resolved = resolveSiloRuntimeConfig('notes', config.silos.notes, config);

    expect(resolved.readOnly).toBe(false);
    expect(resolved.managedBy).toBeUndefined();
    expect(resolved.supportsPathSearch).toBe(true);

    saveLodestoneConfig(p, config);
    const saved = fs.readFileSync(p, 'utf-8');
    expect(saved).not.toContain('read_only');
    expect(saved).not.toContain('managed_by');
    expect(saved).not.toContain('supports_path_search');
  });

  it('parses, validates and round-trips mail accounts independently of silos', () => {
    const hash = accountHash(accountUid('OUTLOOK.Office365.com', 993, 'Case@Example.com'));
    const p = writeConfig(`
server_name = "test"

[mail_accounts.${hash}]
host = "OUTLOOK.Office365.com"
port = 993
username = "Case@Example.com"
display_name = "Work"
credential_kind = "oauth"
oauth_client_id = "client-id"
silo_name = "Mail: Work"
received_after = "2025-09-06T00:00:00Z"
selection_mode = "explicit"
selected_folders = ["INBOX"]
sync_interval_seconds = 300
`);

    const config = loadLodestoneConfig(p);
    expect(config.mail_accounts[hash]).toMatchObject({
      host: 'OUTLOOK.Office365.com',
      username: 'Case@Example.com',
      selection_mode: 'explicit',
      selected_folders: ['INBOX'],
    });
    saveLodestoneConfig(p, config);
    expect(loadLodestoneConfig(p).mail_accounts).toEqual(config.mail_accounts);
  });

  it.each([
    ['invalid port', 'port = 0', 'port must be an integer'],
    ['missing OAuth client', 'oauth_client_id = ""', 'oauth_client_id'],
    ['empty explicit selection', 'selected_folders = []', 'explicit selection'],
    ['invalid cutoff', 'received_after = "last year"', 'received_after'],
  ])('rejects mail config with %s', (_name, replacement, expected) => {
    const username = 'user@example.com';
    const hash = accountHash(accountUid('imap.example.com', 993, username));
    const source = `
[mail_accounts.${hash}]
host = "imap.example.com"
port = 993
username = "${username}"
credential_kind = "oauth"
oauth_client_id = "client-id"
silo_name = "Mail: Example"
received_after = "unlimited"
selection_mode = "explicit"
selected_folders = ["INBOX"]
sync_interval_seconds = 300
`;
    const field = replacement.split(' = ')[0];
    const p = writeConfig(source.replace(new RegExp(`${field} = [^\\n]+`), replacement));
    expect(() => loadLodestoneConfig(p)).toThrow(expected);
  });

  it('rejects a mail account whose table key does not match its identity hash', () => {
    const p = writeConfig(`
[mail_accounts.00000000000000000000000000000000]
host = "imap.example.com"
port = 993
username = "user@example.com"
credential_kind = "password"
silo_name = "Mail: Example"
received_after = "unlimited"
selection_mode = "default"
selected_folders = []
sync_interval_seconds = 300
`);
    expect(() => loadLodestoneConfig(p)).toThrow('does not match its identity');
  });

  it('resolves every path below the account data directory', () => {
    expect(mailDataDir('C:\\Data', 'abc')).toEqual({
      root: path.join('C:\\Data', 'mail', 'abc'),
      mirror: path.join('C:\\Data', 'mail', 'abc', 'mirror'),
      tmp: path.join('C:\\Data', 'mail', 'abc', 'tmp'),
      manifest: path.join('C:\\Data', 'mail', 'abc', 'manifest.sqlite'),
      credential: path.join('C:\\Data', 'mail', 'abc', 'credential.bin'),
    });
  });
});
