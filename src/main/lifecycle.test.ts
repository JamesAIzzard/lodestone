import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createDefaultLodestoneConfig } from '../backend/config';
import { accountHash, accountUid } from '../backend/mail/identity';
import { ensureMailSiloConfig } from '../backend/mail/account-config';

describe('mail account lifecycle configuration', () => {
  it('creates and repairs the linked managed silo policy', () => {
    const hash = accountHash(accountUid('imap.example.com', 993, 'user@example.com'));
    const config = createDefaultLodestoneConfig();
    const account = {
      host: 'imap.example.com',
      port: 993,
      username: 'user@example.com',
      display_name: 'Example',
      credential_kind: 'password' as const,
      silo_name: 'Mail: Example',
      received_after: 'unlimited',
      selection_mode: 'default' as const,
      selected_folders: [] as string[],
      sync_interval_seconds: 300,
    };

    const silo = ensureMailSiloConfig(config, 'C:\\LodestoneData', hash, account);
    expect(silo).toMatchObject({
      indexed_directories: [path.join('C:\\LodestoneData', 'mail', hash, 'mirror')],
      index_db_path: path.join('C:\\LodestoneData', 'mail', hash, 'index.sqlite'),
      indexed_file_extensions: ['md'],
      read_only: true,
      managed_by: `mail:${hash}`,
      supports_path_search: false,
    });

    silo.read_only = false;
    silo.supports_path_search = true;
    silo.indexed_directories = ['C:\\wrong'];
    expect(ensureMailSiloConfig(config, 'C:\\LodestoneData', hash, account)).toMatchObject({
      indexed_directories: [path.join('C:\\LodestoneData', 'mail', hash, 'mirror')],
      read_only: true,
      supports_path_search: false,
    });
  });

  it('does not take over an ordinary silo with the requested name', () => {
    const hash = accountHash(accountUid('imap.example.com', 993, 'user@example.com'));
    const config = createDefaultLodestoneConfig();
    config.silos['Mail: Example'] = {
      indexed_directories: ['C:\\notes'],
      index_db_path: 'C:\\notes.sqlite',
    };
    expect(() =>
      ensureMailSiloConfig(config, 'C:\\LodestoneData', hash, {
        host: 'imap.example.com',
        port: 993,
        username: 'user@example.com',
        display_name: 'Example',
        credential_kind: 'password',
        silo_name: 'Mail: Example',
        received_after: 'unlimited',
        selection_mode: 'default',
        selected_folders: [],
        sync_interval_seconds: 300,
      }),
    ).toThrow('already exists and is not a mail silo');
  });
});
