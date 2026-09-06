export type AccountUid = string;
export type AccountHash = string;
export type MessageKey = string;
export type FolderKey = string;

export type FolderRole =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'junk'
  | 'trash'
  | 'archive'
  | 'all'
  | 'other';

export interface Folder {
  folderKey: FolderKey;
  path: string;
  role: FolderRole;
  uidValidity: number;
}

export interface Entry {
  messageKey: MessageKey;
  receivedAt: Date;
  seen: boolean;
  flagged: boolean;
  labels?: string[];
}

export type BodyStatus = 'complete' | 'truncated' | 'unsupported' | 'encrypted';
export type TextMime = 'text/plain' | 'text/html';

export interface Attachment {
  name: string | null;
  mime: string;
  size: number | null;
}

export interface MessageHeaders {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  date: Date | null;
}

export interface Message {
  headers: MessageHeaders;
  bodyText: string;
  bodyMime: TextMime | null;
  bodyStatus: BodyStatus;
  attachments: Attachment[];
}

export type BodyPartChoice =
  | {
      section: string;
      mime: TextMime;
      encoding: string;
      charset: string;
      declaredSize: number;
    }
  | { status: 'unsupported' | 'encrypted' };

export interface MirrorInput extends Message {
  accountUid: AccountUid;
  messageKey: MessageKey;
  receivedAt: Date;
  folders: string[];
  seen: boolean;
  flagged: boolean;
}
