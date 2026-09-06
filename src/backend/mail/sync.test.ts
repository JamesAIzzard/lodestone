import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeMailAdapter } from './fake-adapter';
import { openManifest, type Manifest } from './manifest';
import * as mirrorFiles from './mirror-files';
import { repairManifest } from './startup-repair';
import { Synchroniser, type MailSelection, type MirrorFileOperations } from './sync';
import type { Entry, Folder, Message } from './types';

const ACCOUNT_UID = 'imap:mail.example.test:993:person@example.test';
const NOW = new Date('2026-09-06T09:00:00Z');

describe('Synchroniser', () => {
  let root: string;
  let manifest: Manifest;
  let manifestPath: string;
  let dirs: mirrorFiles.MirrorDirs;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'lodestone-mail-sync-'));
    manifestPath = path.join(root, 'manifest.sqlite');
    dirs = { mirror: path.join(root, 'mirror'), tmp: path.join(root, 'tmp') };
    manifest = openManifest(manifestPath);
  });

  afterEach(async () => {
    manifest.close();
    await rm(root, { recursive: true, force: true });
  });

  it('mirrors the default selection and excludes drafts, junk and trash', async () => {
    const adapter = standardAdapter();
    add(adapter, 'inbox', 'inbox-message');
    add(adapter, 'sent', 'sent-message');
    add(adapter, 'drafts', 'draft-message');
    add(adapter, 'junk', 'junk-message');
    add(adapter, 'trash', 'trash-message');

    expect(await synchroniser(adapter).runRound()).toBe('completed');

    expect(manifest.messages().map((item) => item.messageKey)).toEqual([
      'inbox-message',
      'sent-message',
    ]);
    expect(await readdir(dirs.mirror)).toHaveLength(2);
  });

  it('uses readable timestamped names and migrates legacy hashed files safely', async () => {
    const adapter = standardAdapter();
    add(adapter, 'inbox', 'Quarterly results');
    const legacyName = 'a383522d27c5834a8f9950ba0c7d0029.md';
    await mirrorFiles.writeMirrorFile(dirs, legacyName, 'legacy');
    manifest.insertMessage({
      messageKey: 'Quarterly results',
      fileName: legacyName,
      receivedAt: NOW.toISOString(),
      labels: null,
      contentHash: 'legacy',
      fetchedAt: NOW.toISOString(),
    });

    expect(await synchroniser(adapter).runRound()).toBe('completed');

    const fileName = required(manifest.message('Quarterly results')).fileName;
    expect(fileName).toBe('Quarterly results -- 2026-09-06 09-00-00Z.md');
    expect(await readdir(dirs.mirror)).toEqual([fileName]);
  });

  it('reports determinate listing and mirroring progress without message content', async () => {
    const adapter = standardAdapter();
    add(adapter, 'inbox', 'one');
    add(adapter, 'inbox', 'two');
    const onProgress = vi.fn();
    const sync = new Synchroniser({
      adapter,
      manifest,
      dirs,
      accountUid: ACCOUNT_UID,
      selection: { ...defaultSelection(), mode: 'explicit', folderKeys: ['inbox'] },
      clock: () => NOW,
      onProgress,
    });

    expect(await sync.runRound()).toBe('completed');
    expect(onProgress).toHaveBeenCalledWith({
      phase: 'mirroring',
      current: 0,
      total: 2,
      folder: 'Inbox',
    });
    expect(onProgress).toHaveBeenCalledWith({
      phase: 'mirroring',
      current: 2,
      total: 2,
      folder: 'Inbox',
    });
    expect(onProgress).toHaveBeenLastCalledWith(null);
    expect(JSON.stringify(onProgress.mock.calls)).not.toContain('one@example.test');
  });

  it('adds, deletes and moves messages on subsequent complete rounds', async () => {
    const adapter = standardAdapter();
    add(adapter, 'inbox', 'first');
    const sync = synchroniser(adapter);
    await sync.runRound();
    const originalFile = required(manifest.message('first')).fileName;

    add(adapter, 'inbox', 'second');
    adapter.moveMessage('first', 'inbox', 'sent');
    await sync.runRound();

    expect(manifest.message('first')?.fileName).toBe(originalFile);
    const moved = await readFile(path.join(dirs.mirror, originalFile), 'utf8');
    expect(moved).toContain('folders:\n  - Sent');
    adapter.deleteMessage('second');
    await sync.runRound();
    expect(manifest.message('second')).toBeNull();
    expect(await readdir(dirs.mirror)).toHaveLength(1);
  });

  it('uses Gmail labels, rewrites label changes and skips drafts', async () => {
    const all: Folder = { folderKey: 'all', path: '[Gmail]/All Mail', role: 'all', uidValidity: 1 };
    const adapter = new FakeMailAdapter({ isGmail: true, folders: [all] });
    add(adapter, 'all', 'gm:1', ['Inbox', 'Project']);
    add(adapter, 'all', 'gm:2', ['\\Draft']);
    const files = spyingFileOperations();
    const sync = synchroniser(adapter, defaultSelection(), files);

    await sync.runRound();
    expect(manifest.message('gm:2')).toBeNull();
    adapter.setLabels('gm:1', ['Inbox', 'Changed']);
    await sync.runRound();

    expect(files.writeMirrorFile).toHaveBeenCalledTimes(2);
    const content = await readFile(
      path.join(dirs.mirror, required(manifest.message('gm:1')).fileName),
      'utf8',
    );
    expect(content).toContain('  - Changed');
  });

  it('does not delete after a partial listing failure and converges next time', async () => {
    const adapter = standardAdapter();
    add(adapter, 'inbox', 'keep');
    add(adapter, 'inbox', 'removed');
    const sync = synchroniser(adapter);
    await sync.runRound();
    const removedFile = required(manifest.message('removed')).fileName;
    adapter.deleteMessage('removed');
    adapter.failListingAfter('inbox', 1);

    expect(await sync.runRound()).toBe('failed');
    expect(await readFile(path.join(dirs.mirror, removedFile), 'utf8')).toContain('removed');
    expect(await sync.runRound()).toBe('completed');
    expect(manifest.message('removed')).toBeNull();
  });

  it('stops on a transient fetch failure and resumes the same round', async () => {
    const adapter = standardAdapter();
    add(adapter, 'inbox', 'retry');
    adapter.failFetch('retry', 'transient');
    const sync = synchroniser(adapter);

    expect(await sync.runRound()).toBe('failed');
    expect(manifest.getState('current_round')).toBe('1');
    expect(manifest.selectedFolders()[0].listedCompleteInRound).toBeNull();
    expect(await sync.runRound()).toBe('completed');
    expect(manifest.message('retry')).not.toBeNull();
    expect(manifest.getState('current_round')).toBe('2');
  });

  it('removes a membership when a listed message vanishes before fetch', async () => {
    const adapter = standardAdapter();
    add(adapter, 'inbox', 'vanished');
    adapter.failFetch('vanished', 'not-found');

    expect(await synchroniser(adapter).runRound()).toBe('completed');
    expect(manifest.message('vanished')).toBeNull();
    expect(manifest.membershipsForMessage('vanished')).toEqual([]);
  });

  it('resumes after its fetch budget without fetching completed messages again', async () => {
    const adapter = standardAdapter();
    add(adapter, 'inbox', 'one');
    add(adapter, 'inbox', 'two');
    let time = 0;
    const originalFetch = adapter.fetchMessage.bind(adapter);
    adapter.fetchMessage = async (key) => {
      const result = await originalFetch(key);
      time += 10;
      return result;
    };
    const sync = new Synchroniser({
      adapter,
      manifest,
      dirs,
      accountUid: ACCOUNT_UID,
      selection: defaultSelection(),
      budgetMs: 10,
      clock: () => new Date(time),
    });

    expect(await sync.runRound()).toBe('budget-exhausted');
    expect(manifest.getState('current_round')).toBe('1');
    expect(await sync.runRound()).toBe('completed');
    const fetches = adapter.commandLog.filter((item) => item.startsWith('fetchMessage:'));
    expect(fetches.filter((item) => item === 'fetchMessage:one')).toHaveLength(1);
    expect(fetches.filter((item) => item === 'fetchMessage:two')).toHaveLength(1);
  });

  it('persists folder-metadata finalisation across budget exhaustion', async () => {
    const adapter = new FakeMailAdapter({
      folders: [folder('anew', 'New', 'archive'), folder('zold', 'Old', 'inbox')],
    });
    add(adapter, 'zold', 'moved');
    let time = 0;
    const originalFetch = adapter.fetchMessage.bind(adapter);
    adapter.fetchMessage = async (key) => {
      const result = await originalFetch(key);
      time += 10;
      return result;
    };
    const sync = new Synchroniser({
      adapter,
      manifest,
      dirs,
      accountUid: ACCOUNT_UID,
      selection: defaultSelection(),
      budgetMs: 10,
      clock: () => new Date(time),
    });
    await sync.runRound();
    adapter.moveMessage('moved', 'zold', 'anew');

    expect(await sync.runRound()).toBe('budget-exhausted');
    expect(manifest.getState('pending_finalisation')).not.toBeNull();
    expect(await sync.runRound()).toBe('completed');

    const content = await readFile(
      path.join(dirs.mirror, required(manifest.message('moved')).fileName),
      'utf8',
    );
    expect(content).toContain('folders:\n  - New');
    expect(content).not.toContain('  - Old');
    expect(manifest.getState('pending_finalisation')).toBeNull();
  });

  it('removes messages excluded by a narrower selection or later cutoff', async () => {
    const adapter = standardAdapter();
    add(adapter, 'inbox', 'old', undefined, new Date('2025-01-01T00:00:00Z'));
    add(adapter, 'sent', 'sent');
    await synchroniser(adapter).runRound();

    const selection: MailSelection = {
      receivedAfter: new Date('2026-01-01T00:00:00Z'),
      mode: 'explicit',
      folderKeys: ['inbox'],
      revision: 2,
    };
    expect(await synchroniser(adapter, selection).runRound()).toBe('completed');
    expect(manifest.messages()).toEqual([]);
  });

  it('rewrites shared-message folder metadata when one folder is deselected', async () => {
    const adapter = standardAdapter();
    add(adapter, 'inbox', 'shared');
    add(adapter, 'sent', 'shared');
    await synchroniser(adapter).runRound();
    const fileName = required(manifest.message('shared')).fileName;

    const inboxOnly: MailSelection = {
      receivedAfter: null,
      mode: 'explicit',
      folderKeys: ['inbox'],
      revision: 2,
    };
    await synchroniser(adapter, inboxOnly).runRound();

    const content = await readFile(path.join(dirs.mirror, fileName), 'utf8');
    expect(content).toContain('folders:\n  - Inbox');
    expect(content).not.toContain('  - Sent');
  });

  it('reports authentication failures without logging message data', async () => {
    const adapter = standardAdapter();
    add(adapter, 'inbox', 'private-subject');
    adapter.failFetch('private-subject', 'auth');
    const log = vi.fn();
    const sync = new Synchroniser({
      adapter,
      manifest,
      dirs,
      accountUid: ACCOUNT_UID,
      selection: defaultSelection(),
      clock: () => NOW,
      log,
    });

    expect(await sync.runRound()).toBe('auth-required');
    expect(manifest.getState('sync_state')).toBe('reauthorisation-required');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-subject');
    expect(JSON.stringify(log.mock.calls)).not.toContain('person@example.test');
  });

  it('does not write anything on an unchanged second round', async () => {
    const adapter = standardAdapter();
    add(adapter, 'inbox', 'stable');
    const files = spyingFileOperations();
    const sync = synchroniser(adapter, defaultSelection(), files);

    await sync.runRound();
    await sync.runRound();
    expect(files.writeMirrorFile).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent round triggers', async () => {
    const adapter = standardAdapter();
    add(adapter, 'inbox', 'coalesced');
    const sync = synchroniser(adapter);

    const first = sync.runRound();
    const second = sync.runRound();
    expect(second).toBe(first);
    await expect(first).resolves.toBe('completed');
    expect(adapter.commandLog.filter((operation) => operation === 'listFolders')).toHaveLength(1);
  });

  it('re-enumerates only the folder whose UIDVALIDITY changed', async () => {
    const adapter = standardAdapter();
    add(adapter, 'inbox', 'inbox-copy');
    add(adapter, 'sent', 'sent-copy');
    const sync = synchroniser(adapter);
    await sync.runRound();
    adapter.commandLog.length = 0;

    adapter.bumpUidValidity('inbox');
    expect(await sync.runRound()).toBe('completed');

    expect(adapter.commandLog).toContain('fetchMessage:inbox-copy');
    expect(adapter.commandLog).not.toContain('fetchMessage:sent-copy');
    expect(manifest.message('sent-copy')).not.toBeNull();
  });

  it('recovers a crash after rename but before manifest insert', async () => {
    const adapter = standardAdapter();
    add(adapter, 'inbox', 'rename-crash');
    let crash = true;
    const files = spyingFileOperations();
    files.writeMirrorFile = vi.fn(async (writeDirs, fileName, content) => {
      await mirrorFiles.writeMirrorFile(writeDirs, fileName, content);
      if (crash) {
        crash = false;
        throw new Error('injected after rename');
      }
    });

    expect(await synchroniser(adapter, defaultSelection(), files).runRound()).toBe('failed');
    expect(manifest.message('rename-crash')).toBeNull();
    expect(await readdir(dirs.mirror)).toHaveLength(1);
    await repairManifest(manifest, dirs);
    expect(await readdir(dirs.mirror)).toEqual([]);
    expect(await synchroniser(adapter).runRound()).toBe('completed');
  });

  it('recovers a crash after insert but before listing completion', async () => {
    const adapter = standardAdapter();
    add(adapter, 'inbox', 'manifest-crash');
    const originalMark = manifest.markListingComplete.bind(manifest);
    const mark = vi.spyOn(manifest, 'markListingComplete');
    mark.mockImplementationOnce(() => {
      throw new Error('injected before markListingComplete');
    });

    expect(await synchroniser(adapter).runRound()).toBe('failed');
    expect(manifest.message('manifest-crash')).not.toBeNull();
    await repairManifest(manifest, dirs);
    mark.mockImplementation(originalMark);
    expect(await synchroniser(adapter).runRound()).toBe('completed');
    expect(
      adapter.commandLog.filter((operation) => operation === 'fetchMessage:manifest-crash'),
    ).toHaveLength(1);
  });

  it('recovers a crash after file deletion but before manifest deletion', async () => {
    const adapter = standardAdapter();
    add(adapter, 'inbox', 'delete-crash');
    await synchroniser(adapter).runRound();
    adapter.deleteMessage('delete-crash');
    let crash = true;
    const files = spyingFileOperations();
    files.deleteMirrorFile = vi.fn(async (deleteDirs, fileName) => {
      await mirrorFiles.deleteMirrorFile(deleteDirs, fileName);
      if (crash) {
        crash = false;
        throw new Error('injected after delete');
      }
    });

    expect(await synchroniser(adapter, defaultSelection(), files).runRound()).toBe('failed');
    expect(manifest.message('delete-crash')).not.toBeNull();
    await repairManifest(manifest, dirs);
    expect(manifest.message('delete-crash')).toBeNull();
    expect(await synchroniser(adapter).runRound()).toBe('completed');
  });

  it('invokes only operations exposed by the adapter interface', async () => {
    const adapter = standardAdapter();
    add(adapter, 'inbox', 'logged');
    await synchroniser(adapter).runRound();

    expect(
      adapter.commandLog.every((operation) =>
        /^(listFolders|listMessages:|fetchMessage:|close)/.test(operation),
      ),
    ).toBe(true);
  });

  it('repairs both sides of a file/row crash boundary', async () => {
    const adapter = standardAdapter();
    add(adapter, 'inbox', 'repair');
    await synchroniser(adapter).runRound();
    const recorded = required(manifest.message('repair'));
    await mirrorFiles.deleteMirrorFile(dirs, recorded.fileName);

    await repairManifest(manifest, dirs);
    expect(manifest.message('repair')).toBeNull();
    await synchroniser(adapter).runRound();
    expect(manifest.message('repair')).not.toBeNull();

    await mirrorFiles.writeMirrorFile(dirs, 'orphan.md', 'orphan');
    await repairManifest(manifest, dirs);
    expect(await readdir(dirs.mirror)).not.toContain('orphan.md');
  });

  function synchroniser(
    adapter: FakeMailAdapter,
    selection = defaultSelection(),
    fileOperations?: MirrorFileOperations,
  ): Synchroniser {
    return new Synchroniser({
      adapter,
      manifest,
      dirs,
      accountUid: ACCOUNT_UID,
      selection,
      clock: () => NOW,
      fileOperations,
    });
  }

  function spyingFileOperations(): MirrorFileOperations {
    return {
      cleanTmp: vi.fn(mirrorFiles.cleanTmp),
      writeMirrorFile: vi.fn(mirrorFiles.writeMirrorFile),
      deleteMirrorFile: vi.fn(mirrorFiles.deleteMirrorFile),
    };
  }
});

function standardAdapter(): FakeMailAdapter {
  return new FakeMailAdapter({
    folders: [
      folder('inbox', 'Inbox', 'inbox'),
      folder('sent', 'Sent', 'sent'),
      folder('drafts', 'Drafts', 'drafts'),
      folder('junk', 'Junk', 'junk'),
      folder('trash', 'Trash', 'trash'),
    ],
  });
}

function folder(folderKey: string, folderPath: string, role: Folder['role']): Folder {
  return { folderKey, path: folderPath, role, uidValidity: 1 };
}

function add(
  adapter: FakeMailAdapter,
  folderKey: string,
  messageKey: string,
  labels?: string[],
  receivedAt = NOW,
): void {
  const entry: Entry = { messageKey, receivedAt, seen: true, flagged: false, labels };
  const message: Message = {
    headers: {
      messageId: `<${messageKey}@example.test>`,
      inReplyTo: null,
      references: [],
      subject: messageKey,
      from: 'Sender <sender@example.test>',
      to: ['Person <person@example.test>'],
      cc: [],
      date: receivedAt,
    },
    bodyText: `Body for ${messageKey}`,
    bodyMime: 'text/plain',
    bodyStatus: 'complete',
    attachments: [],
  };
  adapter.addMessage(folderKey, entry, message);
}

function defaultSelection(): MailSelection {
  return { receivedAfter: null, mode: 'default', folderKeys: [], revision: 1 };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected value to be present');
  return value;
}
