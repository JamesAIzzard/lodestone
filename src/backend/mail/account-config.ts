import path from 'node:path';

import {
  mailDataDir,
  type LodestoneConfig,
  type MailAccountTomlConfig,
  type SiloTomlConfig,
} from '../config';

export function ensureMailSiloConfig(
  config: LodestoneConfig,
  userDataDir: string,
  hash: string,
  account: MailAccountTomlConfig,
): SiloTomlConfig {
  const paths = mailDataDir(userDataDir, hash);
  const owner = `mail:${hash}`;
  const existing = config.silos[account.silo_name];
  if (existing?.managed_by && existing.managed_by !== owner) {
    throw new Error(`Silo "${account.silo_name}" is managed by another source.`);
  }
  if (existing && !existing.managed_by) {
    throw new Error(`Silo "${account.silo_name}" already exists and is not a mail silo.`);
  }
  const silo: SiloTomlConfig = {
    ...existing,
    indexed_directories: [paths.mirror],
    index_db_path: existing?.index_db_path ?? path.join(paths.root, 'index.sqlite'),
    indexed_file_extensions: ['.md'],
    read_only: true,
    managed_by: owner,
    supports_path_search: false,
  };
  delete silo.is_stopped;
  config.silos[account.silo_name] = silo;
  return silo;
}
