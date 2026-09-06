import { describe, expect, it } from 'vitest';
import { createImapAdapter, IMAP_COMMAND_ALLOWLIST } from './imap-adapter';
import type { Entry, Folder, Message } from './types';

const hasStandardCredentials = Boolean(
  process.env.LODESTONE_TEST_IMAP_HOST &&
  process.env.LODESTONE_TEST_IMAP_USER &&
  process.env.LODESTONE_TEST_IMAP_PASSWORD,
);
const hasGmailCredentials = Boolean(
  process.env.LODESTONE_TEST_GMAIL_USER && process.env.LODESTONE_TEST_GMAIL_APP_PASSWORD,
);

describe.skipIf(!hasStandardCredentials)('IMAP adapter integration', () => {
  it('lists and fetches recent messages without leaving the command allowlist', async () => {
    const fetchBytes: number[] = [];
    const adapter = createImapAdapter({
      host: requiredEnvironment('LODESTONE_TEST_IMAP_HOST'),
      port: Number(process.env.LODESTONE_TEST_IMAP_PORT ?? 993),
      username: requiredEnvironment('LODESTONE_TEST_IMAP_USER'),
      auth: {
        kind: 'password',
        password: requiredEnvironment('LODESTONE_TEST_IMAP_PASSWORD'),
      },
      log: (event, details) => {
        if (event === 'imap-message-fetched' && typeof details.received_bytes === 'number') {
          fetchBytes.push(details.received_bytes);
        }
      },
    });
    try {
      const folders = await adapter.listFolders();
      const folder = inboxOrFirst(folders);
      const entries = await recentEntries(adapter, folder);
      const messages: Message[] = [];
      for (const entry of entries.slice(-3)) {
        messages.push(await adapter.fetchMessage(entry.messageKey));
      }

      expect(folders.length).toBeGreaterThan(0);
      expect(messages.every((message) => Boolean(message.bodyStatus))).toBe(true);
      expect(messages.some((message) => message.bodyText.trim())).toBe(true);
      expect(fetchBytes).toHaveLength(messages.length);
      expect(fetchBytes.every((bytes) => bytes < 3 * 1024 * 1024)).toBe(true);
      expect(adapter.commandLog.every((command) => IMAP_COMMAND_ALLOWLIST.has(command))).toBe(true);
    } finally {
      await adapter.close();
    }
  }, 120_000);
});

describe.skipIf(!hasGmailCredentials)('Gmail IMAP adapter integration', () => {
  it('uses All Mail, Gmail message IDs and labels', async () => {
    const adapter = createImapAdapter({
      host: 'imap.gmail.com',
      port: 993,
      username: requiredEnvironment('LODESTONE_TEST_GMAIL_USER'),
      auth: {
        kind: 'password',
        password: requiredEnvironment('LODESTONE_TEST_GMAIL_APP_PASSWORD'),
      },
      log: () => undefined,
    });
    try {
      const folders = await adapter.listFolders();
      const entries = await recentEntries(adapter, folders[0]);

      expect(folders).toHaveLength(1);
      expect(folders[0].role).toBe('all');
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((entry) => entry.messageKey.startsWith('gm:'))).toBe(true);
      expect(entries.every((entry) => Array.isArray(entry.labels))).toBe(true);
      expect(adapter.commandLog.every((command) => IMAP_COMMAND_ALLOWLIST.has(command))).toBe(true);
    } finally {
      await adapter.close();
    }
  }, 120_000);
});

function inboxOrFirst(folders: Folder[]): Folder {
  const folder = folders.find((candidate) => candidate.role === 'inbox') ?? folders[0];
  if (!folder) throw new Error('The server returned no selectable folders.');
  return folder;
}

async function recentEntries(
  adapter: ReturnType<typeof createImapAdapter>,
  folder: Folder,
): Promise<Entry[]> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 30);
  const entries: Entry[] = [];
  for await (const entry of adapter.listMessages(folder, cutoff)) entries.push(entry);
  return entries;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for this integration test.`);
  return value;
}
