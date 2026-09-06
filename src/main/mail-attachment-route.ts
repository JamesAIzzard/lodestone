import fs from 'node:fs';
import path from 'node:path';

import type { MailAccount } from '../backend/mail/account';
import { isPathWithinRoot } from '../backend/mcp/puid-manager';
import type { SiloManager } from '../backend/silo-manager';

export type MailMirrorResolution =
  | { account: MailAccount; fileName: string; siloName: string }
  | { code: 'not-email' | 'unavailable'; message: string };

export function resolveMailMirrorFile(
  dependencies: {
    siloManagers: Map<string, SiloManager>;
    mailAccounts: Map<string, MailAccount>;
  },
  filePath: string,
): MailMirrorResolution {
  const matches = [...dependencies.siloManagers.entries()].flatMap(([siloName, manager]) =>
    manager
      .getConfig()
      .indexedDirectories.filter((root) => isPathWithinRoot(filePath, root))
      .map((root) => ({ siloName, manager, root })),
  );
  if (matches.length !== 1) return notEmail();

  const { siloName, manager, root } = matches[0];
  const config = manager.getConfig();
  const ownership = /^mail:([^:]+)$/.exec(config.managedBy ?? '');
  if (!config.readOnly || !ownership) return notEmail();
  if (manager.isStopped || !manager.isAvailable) {
    return { code: 'unavailable', message: 'This mail source is temporarily unavailable.' };
  }
  const canonicalFile = canonicalPath(filePath);
  const canonicalRoot = canonicalPath(root);
  if (
    path.dirname(canonicalFile).toLowerCase() !== canonicalRoot.toLowerCase() ||
    path.extname(canonicalFile).toLowerCase() !== '.md'
  ) {
    return notEmail();
  }

  const accountHash = ownership[1];
  const account = dependencies.mailAccounts.get(accountHash);
  if (!account) {
    return { code: 'unavailable', message: 'This mail source is temporarily unavailable.' };
  }
  return { account, fileName: path.basename(canonicalFile), siloName };
}

function canonicalPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  return fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved;
}

function notEmail(): MailMirrorResolution {
  return { code: 'not-email', message: 'The reference is not a mirrored email.' };
}
