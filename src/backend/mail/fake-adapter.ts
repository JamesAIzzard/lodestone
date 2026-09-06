import {
  AdapterError,
  type AdapterErrorKind,
  type MailAdapter,
  type MailAdapterOperation,
} from './adapter';
import type { Entry, Folder, FolderKey, Message, MessageKey } from './types';

interface FakeFolder {
  folder: Folder;
  entries: Map<MessageKey, Entry>;
}

export class FakeMailAdapter implements MailAdapter {
  readonly commandLog: MailAdapterOperation[] = [];
  readonly isGmail: boolean;

  private readonly folders = new Map<FolderKey, FakeFolder>();
  private readonly messages = new Map<MessageKey, Message>();
  private readonly listingFailures = new Map<FolderKey, number>();
  private readonly fetchFailures = new Map<MessageKey, AdapterErrorKind>();
  private throttledOperations = 0;

  constructor(options: { isGmail?: boolean; folders?: Folder[] } = {}) {
    this.isGmail = options.isGmail ?? false;
    for (const folder of options.folders ?? []) this.addFolder(folder);
  }

  async listFolders(): Promise<Folder[]> {
    this.record('listFolders');
    return [...this.folders.values()].map(({ folder }) => ({ ...folder }));
  }

  async *listMessages(folder: Folder, receivedAfter: Date | null = null): AsyncIterable<Entry> {
    this.record(`listMessages:${folder.folderKey}`);
    const stored = this.folders.get(folder.folderKey);
    if (!stored) throw new AdapterError('not-found');
    const failAfter = this.listingFailures.get(folder.folderKey);
    let yielded = 0;
    for (const entry of stored.entries.values()) {
      if (receivedAfter && entry.receivedAt < receivedAfter) continue;
      if (failAfter !== undefined && yielded >= failAfter) {
        this.listingFailures.delete(folder.folderKey);
        throw new AdapterError('transient');
      }
      yielded += 1;
      yield cloneEntry(entry);
    }
    if (failAfter !== undefined && yielded >= failAfter) {
      this.listingFailures.delete(folder.folderKey);
      throw new AdapterError('transient');
    }
  }

  async fetchMessage(messageKey: MessageKey): Promise<Message> {
    this.record(`fetchMessage:${messageKey}`);
    const failure = this.fetchFailures.get(messageKey);
    if (failure) {
      this.fetchFailures.delete(messageKey);
      throw new AdapterError(failure);
    }
    const message = this.messages.get(messageKey);
    if (!message) throw new AdapterError('not-found');
    return structuredClone(message);
  }

  async close(): Promise<void> {
    this.record('close');
  }

  addFolder(folder: Folder): void {
    this.folders.set(folder.folderKey, { folder: { ...folder }, entries: new Map() });
  }

  removeFolder(folderKey: FolderKey): void {
    this.folders.delete(folderKey);
  }

  addMessage(folderKey: FolderKey, entry: Entry, message: Message): void {
    const folder = this.requireFolder(folderKey);
    folder.entries.set(entry.messageKey, cloneEntry(entry));
    this.messages.set(entry.messageKey, structuredClone(message));
  }

  deleteMessage(messageKey: MessageKey, folderKey?: FolderKey): void {
    if (folderKey) this.requireFolder(folderKey).entries.delete(messageKey);
    else for (const folder of this.folders.values()) folder.entries.delete(messageKey);
    if (![...this.folders.values()].some((folder) => folder.entries.has(messageKey))) {
      this.messages.delete(messageKey);
    }
  }

  moveMessage(messageKey: MessageKey, from: FolderKey, to: FolderKey): void {
    const entry = this.requireFolder(from).entries.get(messageKey);
    if (!entry) throw new Error(`Unknown message: ${messageKey}`);
    this.requireFolder(from).entries.delete(messageKey);
    this.requireFolder(to).entries.set(messageKey, cloneEntry(entry));
  }

  setLabels(messageKey: MessageKey, labels: string[]): void {
    for (const folder of this.folders.values()) {
      const entry = folder.entries.get(messageKey);
      if (entry) entry.labels = [...labels];
    }
  }

  setFlags(messageKey: MessageKey, flags: { seen?: boolean; flagged?: boolean }): void {
    for (const folder of this.folders.values()) {
      const entry = folder.entries.get(messageKey);
      if (!entry) continue;
      if (flags.seen !== undefined) entry.seen = flags.seen;
      if (flags.flagged !== undefined) entry.flagged = flags.flagged;
    }
  }

  bumpUidValidity(folderKey: FolderKey): void {
    this.requireFolder(folderKey).folder.uidValidity += 1;
  }

  failListingAfter(folderKey: FolderKey, count: number): void {
    this.listingFailures.set(folderKey, count);
  }

  failFetch(messageKey: MessageKey, kind: AdapterErrorKind): void {
    this.fetchFailures.set(messageKey, kind);
  }

  throttleNext(count: number): void {
    this.throttledOperations += count;
  }

  private requireFolder(folderKey: FolderKey): FakeFolder {
    const folder = this.folders.get(folderKey);
    if (!folder) throw new Error(`Unknown folder: ${folderKey}`);
    return folder;
  }

  private record(operation: MailAdapterOperation): void {
    this.commandLog.push(operation);
    if (this.throttledOperations > 0) {
      this.throttledOperations -= 1;
      throw new AdapterError('transient', 'throttled');
    }
  }
}

function cloneEntry(entry: Entry): Entry {
  return {
    ...entry,
    receivedAt: new Date(entry.receivedAt),
    labels: entry.labels && [...entry.labels],
  };
}
