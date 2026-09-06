import type { Folder } from '../../../backend/mail/types';

const DEFAULT_EXCLUDED_ROLES = new Set(['drafts', 'junk', 'trash']);

export const MAIL_STORAGE_SUMMARY =
  'Message text and search index data will be stored unencrypted under the Lodestone data directory. Attachments are never stored; one is downloaded only when explicitly requested through MCP and is discarded after the response.';

export function defaultFolderSelection(folders: Folder[], isGmail: boolean): string[] {
  if (isGmail) {
    const allMail = folders.find((folder) => folder.role === 'all');
    return allMail ? [allMail.folderKey] : [];
  }
  return folders
    .filter((folder) => !DEFAULT_EXCLUDED_ROLES.has(folder.role))
    .map((folder) => folder.folderKey);
}

export function folderSelectionLocked(folder: Folder, isGmail: boolean): boolean {
  return isGmail || DEFAULT_EXCLUDED_ROLES.has(folder.role);
}

export function defaultSiloName(displayName: string): string {
  return `Mail: ${displayName.trim()}`;
}

export function defaultReceivedAfter(now = new Date()): string {
  const cutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1_000);
  return cutoff.toISOString().slice(0, 10);
}

export function dateInputToReceivedAfter(value: string): string {
  return `${value}T00:00:00.000Z`;
}

export function receivedAfterToDateInput(value: string): string {
  return value === 'unlimited' ? '' : value.slice(0, 10);
}

export function inferredDisplayName(username: string): string {
  const localPart = username.split('@')[0] ?? username;
  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
