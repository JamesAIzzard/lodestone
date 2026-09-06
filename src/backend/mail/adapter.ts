import type { Attachment, Entry, Folder, FolderKey, Message, MessageKey } from './types';
import type { AttachmentContent } from './attachment';

export type AdapterErrorKind =
  | 'auth'
  | 'transient'
  | 'not-found'
  | 'too-large'
  | 'stale'
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
  listMessages(
    folder: Folder,
    receivedAfter?: Date | null,
    onCount?: (total: number) => void,
  ): AsyncIterable<Entry>;
  fetchMessage(messageKey: MessageKey): Promise<Message>;
  fetchAttachment(
    messageKey: MessageKey,
    attachmentIndex: number,
    options: {
      maxBytes: number;
      expected: { count: number; attachment: Attachment };
    },
  ): Promise<AttachmentContent>;
  close(): Promise<void>;
}

export type MailAdapterOperation =
  | 'listFolders'
  | `listMessages:${FolderKey}`
  | `fetchMessage:${MessageKey}`
  | `fetchAttachment:${MessageKey}:${number}`
  | 'close';
