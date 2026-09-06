import { describe, expect, it } from 'vitest';

import type { Folder } from '../../../backend/mail/types';
import {
  defaultFolderSelection,
  defaultReceivedAfter,
  defaultSiloName,
  folderSelectionLocked,
  MAIL_STORAGE_SUMMARY,
} from './mail-ui';

const folders: Folder[] = [
  { folderKey: 'INBOX', path: 'Inbox', role: 'inbox', uidValidity: 1 },
  { folderKey: 'Sent', path: 'Sent', role: 'sent', uidValidity: 1 },
  { folderKey: 'Drafts', path: 'Drafts', role: 'drafts', uidValidity: 1 },
  { folderKey: 'Spam', path: 'Spam', role: 'junk', uidValidity: 1 },
  { folderKey: 'Trash', path: 'Trash', role: 'trash', uidValidity: 1 },
];

describe('mail wizard helpers', () => {
  it('applies the default folder selection rule', () => {
    expect(defaultFolderSelection(folders, false)).toEqual(['INBOX', 'Sent']);
    expect(folderSelectionLocked(folders[2], false)).toBe(true);
  });

  it('locks Gmail to its single All Mail folder', () => {
    const gmailFolders: Folder[] = [
      { folderKey: '[Gmail]/All Mail', path: 'All Mail', role: 'all', uidValidity: 2 },
      ...folders,
    ];
    expect(defaultFolderSelection(gmailFolders, true)).toEqual(['[Gmail]/All Mail']);
    expect(gmailFolders.every((folder) => folderSelectionLocked(folder, true))).toBe(true);
  });

  it('builds the default silo name from the display name', () => {
    expect(defaultSiloName(' Nuanced Bio ')).toBe('Mail: Nuanced Bio');
    expect(defaultReceivedAfter(new Date('2024-03-01T12:00:00Z'))).toBe('2023-03-02');
  });

  it('states that message and index data are stored unencrypted', () => {
    expect(MAIL_STORAGE_SUMMARY).toBe(
      'Message text and search index data will be stored unencrypted under the Lodestone data directory.',
    );
  });
});
