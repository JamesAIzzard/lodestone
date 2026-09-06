import type { Entry, Folder, FolderKey, Message, MessageKey } from './types';

export type AdapterErrorKind =
  | 'auth'
  | 'transient'
  | 'not-found'
  | 'unsupported'
  | 'encrypted'
  | 'protocol';

export class AdapterError extends Error {
  constructor(
    public readonly kind: AdapterErrorKind,
    message?: string,
    options?: ErrorOptions,
  ) {
    super(message ?? kind, options);
    this.name = 'AdapterError';
  }
}

export interface MailAdapter {
  readonly isGmail?: boolean;
  listFolders(): Promise<Folder[]>;
  listMessages(folder: Folder, receivedAfter?: Date | null): AsyncIterable<Entry>;
  fetchMessage(messageKey: MessageKey): Promise<Message>;
  close(): Promise<void>;
}

export type MailAdapterOperation =
  | 'listFolders'
  | `listMessages:${FolderKey}`
  | `fetchMessage:${MessageKey}`
  | 'close';
