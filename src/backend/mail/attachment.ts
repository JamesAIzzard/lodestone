export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENT_TEXT_BYTES = 512 * 1024;

export interface AttachmentContent {
  bytes: Uint8Array;
  mime: string;
  name: string | null;
  charset: string | null;
  declaredSize: number | null;
}

export type AttachmentFetchErrorCode =
  | 'not-email'
  | 'unavailable'
  | 'not-found'
  | 'stale'
  | 'too-large'
  | 'encrypted'
  | 'unsupported'
  | 'auth'
  | 'transient'
  | 'protocol';

export type AttachmentFetchResponse =
  | {
      kind: 'attachment';
      dataBase64: string;
      mime: string;
      name: string | null;
      charset: string | null;
      size: number;
    }
  | { kind: 'error'; code: AttachmentFetchErrorCode; message: string };
