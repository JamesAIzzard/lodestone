import { ImapFlow } from 'imapflow';
import type {
  FetchMessageObject,
  FetchQueryObject,
  ImapFlowOptions,
  ListOptions,
  ListResponse,
  Logger,
  MailboxLockObject,
  MailboxObject,
  MessageStructureObject,
  SearchObject,
} from 'imapflow';
import libmime from 'libmime';
import { AdapterError, type MailAdapter } from './adapter';
import { chooseBodyPart, listAttachments, PARTIAL_FETCH_LIMIT } from './body-part';
import { decodeBodyPart, htmlToText } from './decode';
import type { Entry, Folder, FolderRole, Message, MessageHeaders, MessageKey } from './types';

export type ImapAuth =
  | { kind: 'password'; password: string }
  | {
      kind: 'xoauth2';
      accessToken: (() => Promise<string>) & { invalidate?: () => void };
    };

export type ImapAdapterLog = (event: string, details: Record<string, string | number>) => void;

export interface CreateImapAdapterOptions {
  host: string;
  port: number;
  username: string;
  auth: ImapAuth;
  log: ImapAdapterLog;
}

export const IMAP_COMMAND_ALLOWLIST = new Set([
  'CAPABILITY',
  'ID',
  'ENABLE',
  'AUTHENTICATE',
  'LOGIN',
  'NOOP',
  'LOGOUT',
  'LIST',
  'STATUS',
  'EXAMINE',
  'SEARCH',
  'FETCH',
  'NAMESPACE',
  'COMPRESS',
]);

interface ImapClient {
  capabilities: Map<string, boolean | number>;
  mailbox: MailboxObject | false;
  usable: boolean;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  connect(): Promise<void>;
  logout(): Promise<void>;
  list(options?: ListOptions & { listOnly?: boolean }): Promise<ListResponse[]>;
  status(path: string, query: { uidValidity: true }): Promise<{ uidValidity?: bigint }>;
  getMailboxLock(path: string, options: { readOnly: true }): Promise<MailboxLockObject>;
  search(query: SearchObject, options: { uid: true }): Promise<number[] | false>;
  fetch(
    range: number[],
    query: FetchQueryObject,
    options: { uid: true },
  ): AsyncIterableIterator<FetchMessageObject>;
  fetchOne(
    uid: number,
    query: FetchQueryObject,
    options: { uid: true },
  ): Promise<FetchMessageObject | false>;
  download(
    uid: number,
    part: string,
    options: { uid: true; maxBytes: number },
  ): Promise<{ content: NodeJS.ReadableStream }>;
  stats(): { sent: number; received: number };
}

type ClientFactory = (options: ImapFlowOptions) => ImapClient;

export interface ImapMailAdapter extends MailAdapter {
  readonly commandLog: readonly string[];
  readonly supportsCondstore: boolean;
  readonly supportsQresync: boolean;
}

interface MessageLocation {
  folderPath: string;
  uid: number;
  uidValidity: number;
}

export function createImapAdapter(
  options: CreateImapAdapterOptions,
  clientFactory: ClientFactory = (clientOptions) => new ImapFlow(clientOptions),
): ImapMailAdapter {
  const commandLog: string[] = [];
  const logger = createCommandLogger(commandLog, options.log);
  const createClient = (credential: { pass: string } | { accessToken: string }): ImapClient => {
    const client = clientFactory({
      host: options.host,
      port: options.port,
      secure: true,
      auth: { user: options.username, ...credential },
      logger,
      disableAutoIdle: true,
      disableAutoEnable: true,
      disableBinary: true,
      connectionTimeout: 30_000,
      socketTimeout: 60_000,
    });
    client.on('error', (error) =>
      options.log('imap-error', { error_kind: mapImapError(error).kind }),
    );
    return client;
  };
  const initialClient =
    options.auth.kind === 'password' ? createClient({ pass: options.auth.password }) : null;
  return new ImapFlowAdapter(initialClient, createClient, options.auth, commandLog, options.log);
}

class ImapFlowAdapter implements ImapMailAdapter {
  private connectPromise: Promise<void> | null = null;
  private connected = false;
  private gmail = false;
  private condstore = false;
  private qresync = false;
  private gmailFolder: Folder | undefined;
  private readonly locations = new Map<MessageKey, MessageLocation>();

  constructor(
    private client: ImapClient | null,
    private readonly createClient: (
      credential: { pass: string } | { accessToken: string },
    ) => ImapClient,
    private readonly auth: ImapAuth,
    readonly commandLog: readonly string[],
    private readonly log: ImapAdapterLog,
  ) {}

  get isGmail(): boolean {
    return this.gmail;
  }

  get supportsCondstore(): boolean {
    return this.condstore;
  }

  get supportsQresync(): boolean {
    return this.qresync;
  }

  async listFolders(): Promise<Folder[]> {
    return this.run(async () => {
      await this.ensureConnected();
      const client = this.requireClient();
      const listed = await client.list({ statusQuery: { uidValidity: true }, listOnly: true });
      const selectable = listed.filter((item) => !hasAttribute(item.flags, '\\Noselect'));
      const folders = await Promise.all(
        selectable.map(async (item) => {
          const uidValidity =
            item.status?.uidValidity ??
            (await client.status(item.path, { uidValidity: true })).uidValidity;
          return folderFromListResponse(item, uidValidity);
        }),
      );
      if (!this.gmail) return folders;
      const gmailFolders = folders.filter((folder) => folder.role === 'all').slice(0, 1);
      this.gmailFolder = gmailFolders[0];
      return gmailFolders;
    });
  }

  async *listMessages(folder: Folder, receivedAfter: Date | null = null): AsyncIterable<Entry> {
    try {
      await this.ensureConnected();
      const client = this.requireClient();
      const lock = await client.getMailboxLock(folder.path, { readOnly: true });
      try {
        const uidValidity = currentUidValidity(client.mailbox);
        if (uidValidity !== folder.uidValidity) {
          throw new AdapterError('protocol', 'uidvalidity-changed');
        }
        const uids = await client.search(
          receivedAfter ? { since: utcCalendarDay(receivedAfter) } : { all: true },
          { uid: true },
        );
        if (!uids) return;

        for (const batch of batches(uids, 500)) {
          const query: FetchQueryObject = {
            uid: true,
            internalDate: true,
            flags: true,
            ...(this.gmail ? { labels: true } : {}),
          };
          for await (const item of client.fetch(batch, query, { uid: true })) {
            const entry = this.entryFromFetch(item, folder, uidValidity, receivedAfter);
            if (entry) yield entry;
          }
        }
      } finally {
        lock.release();
      }
    } catch (error) {
      throw mapImapError(error);
    }
  }

  async fetchMessage(messageKey: MessageKey): Promise<Message> {
    return this.run(async () => {
      await this.ensureConnected();
      const client = this.requireClient();
      let location = this.locationFor(messageKey);
      if (!location) {
        const folder = this.gmailFolder ?? (await this.listFolders())[0];
        if (!folder || folder.role !== 'all') throw new AdapterError('not-found');
        location = { folderPath: folder.path, uid: 0, uidValidity: folder.uidValidity };
      }
      const lock = await client.getMailboxLock(location.folderPath, { readOnly: true });
      try {
        const receivedBefore = client.stats().received;
        if (currentUidValidity(client.mailbox) !== location.uidValidity) {
          throw new AdapterError('protocol', 'uidvalidity-changed');
        }
        if (location.uid === 0) {
          const uids = await client.search({ emailId: messageKey.slice(3) }, { uid: true });
          const uid = uids && uids[0];
          if (!uid) throw new AdapterError('not-found');
          location = { ...location, uid };
          this.locations.set(messageKey, location);
        }
        const fetched = await client.fetchOne(
          location.uid,
          { bodyStructure: true, headers: true },
          { uid: true },
        );
        if (!fetched) throw new AdapterError('not-found');
        if (!fetched.bodyStructure || !fetched.headers) {
          throw new AdapterError('protocol', 'missing-message-metadata');
        }

        const message = await this.messageFromFetch(
          location.uid,
          fetched.bodyStructure,
          fetched.headers,
        );
        this.log('imap-message-fetched', {
          received_bytes: client.stats().received - receivedBefore,
        });
        return message;
      } finally {
        lock.release();
      }
    });
  }

  async close(): Promise<void> {
    if (!this.connected && !this.connectPromise) return;
    try {
      await this.connectPromise;
      if (this.client?.usable) await this.client.logout();
    } catch (error) {
      throw mapImapError(error);
    } finally {
      this.connected = false;
      this.connectPromise = null;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected && this.client?.usable) return;
    if (!this.connectPromise) {
      this.connectPromise = this.connect();
    }
    const pending = this.connectPromise;
    try {
      await pending;
    } finally {
      if (this.connectPromise === pending) this.connectPromise = null;
    }
  }

  private async connect(): Promise<void> {
    if (this.auth.kind === 'password') {
      this.client ??= this.createClient({ pass: this.auth.password });
      await this.connectClient(this.client);
      return;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const accessToken = await this.auth.accessToken();
      const client = this.createClient({ accessToken });
      this.client = client;
      try {
        await this.connectClient(client);
        return;
      } catch (error) {
        const mapped = mapImapError(error);
        this.client = null;
        this.connected = false;
        if (attempt === 0 && mapped.kind === 'auth') {
          this.auth.accessToken.invalidate?.();
          continue;
        }
        throw mapped;
      }
    }
  }

  private async connectClient(client: ImapClient): Promise<void> {
    await client.connect();
    this.connected = true;
    this.gmail = client.capabilities.has('X-GM-EXT-1');
    this.condstore = client.capabilities.has('CONDSTORE');
    this.qresync = client.capabilities.has('QRESYNC');
  }

  private requireClient(): ImapClient {
    if (!this.client) throw new AdapterError('protocol', 'imap-client-unavailable');
    return this.client;
  }

  private entryFromFetch(
    item: FetchMessageObject,
    folder: Folder,
    uidValidity: number,
    receivedAfter: Date | null,
  ): Entry | null {
    const receivedAt = parseInternalDate(item.internalDate);
    if (!receivedAt) throw new AdapterError('protocol', 'missing-internaldate');
    if (receivedAfter && receivedAt < receivedAfter) return null;

    const labels = this.gmail ? [...(item.labels ?? [])] : undefined;
    if (labels?.some((label) => label.toLowerCase() === '\\draft')) return null;
    const messageKey = formMessageKey(
      folder.folderKey,
      uidValidity,
      item.uid,
      item.emailId,
      this.gmail,
    );
    this.locations.set(messageKey, { folderPath: folder.path, uid: item.uid, uidValidity });
    return {
      messageKey,
      receivedAt,
      seen: hasAttribute(item.flags, '\\Seen'),
      flagged: hasAttribute(item.flags, '\\Flagged'),
      labels,
    };
  }

  private locationFor(messageKey: MessageKey): MessageLocation | undefined {
    const cached = this.locations.get(messageKey);
    if (cached) return cached;
    const parsed = parseUidMessageKey(messageKey);
    if (parsed)
      return { folderPath: parsed.folderKey, uid: parsed.uid, uidValidity: parsed.uidValidity };
    if (this.gmail && messageKey.startsWith('gm:')) return undefined;
    throw new AdapterError('not-found');
  }

  private async messageFromFetch(
    uid: number,
    structure: MessageStructureObject,
    rawHeaders: Buffer,
  ): Promise<Message> {
    const client = this.requireClient();
    const attachments = listAttachments(structure);
    const choice = chooseBodyPart(structure);
    if ('status' in choice) {
      return {
        headers: normaliseHeaders(rawHeaders),
        bodyText: '',
        bodyMime: null,
        bodyStatus: choice.status,
        attachments,
      };
    }

    const download = await client.download(uid, choice.section, {
      uid: true,
      maxBytes: PARTIAL_FETCH_LIMIT,
    });
    const bytes = await readStream(download.content, PARTIAL_FETCH_LIMIT);
    // ImapFlow's download stream has already decoded transfer encoding and charset.
    const decoded = decodeBodyPart(bytes, '8bit', 'utf-8');
    return {
      headers: normaliseHeaders(rawHeaders),
      bodyText: choice.mime === 'text/html' ? htmlToText(decoded) : decoded,
      bodyMime: choice.mime,
      bodyStatus: choice.declaredSize > PARTIAL_FETCH_LIMIT ? 'truncated' : 'complete',
      attachments,
    };
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw mapImapError(error);
    }
  }
}

export function createCommandLogger(commandLog: string[], log: ImapAdapterLog): Logger {
  const inspect = (entry: unknown): void => {
    if (!isRecord(entry) || entry.src !== 'c' || typeof entry.msg !== 'string') return;
    const command = outgoingCommand(entry.msg);
    if (!command) return;
    if (!IMAP_COMMAND_ALLOWLIST.has(command)) {
      throw new AdapterError('protocol', `imap-command-not-allowed:${command}`);
    }
    if (
      command === 'FETCH' &&
      /BODY(?:\.PEEK)?\[/i.test(entry.msg) &&
      !/BODY\.PEEK\[/i.test(entry.msg)
    ) {
      throw new AdapterError('protocol', 'imap-fetch-without-peek');
    }
    commandLog.push(command);
    log('imap-command', { command });
  };
  return { debug: inspect, info: () => undefined, warn: () => undefined, error: () => undefined };
}

export function mapFolderRole(path: string, specialUse?: string, flags?: Set<string>): FolderRole {
  const attributes = new Set([...(flags ?? []), ...(specialUse ? [specialUse] : [])].map(lower));
  const roles: Array<[string, FolderRole]> = [
    ['\\inbox', 'inbox'],
    ['\\sent', 'sent'],
    ['\\drafts', 'drafts'],
    ['\\junk', 'junk'],
    ['\\trash', 'trash'],
    ['\\archive', 'archive'],
    ['\\all', 'all'],
  ];
  for (const [attribute, role] of roles) if (attributes.has(attribute)) return role;

  const name = path.split(/[/.]/).at(-1)?.toLowerCase();
  if (name === 'inbox') return 'inbox';
  if (name === 'drafts') return 'drafts';
  if (name === 'junk' || name === 'spam') return 'junk';
  if (name === 'trash' || name === 'deleted') return 'trash';
  if (name === 'sent') return 'sent';
  if (name === 'archive') return 'archive';
  return 'other';
}

export function utcCalendarDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function formMessageKey(
  folderKey: string,
  uidValidity: number,
  uid: number,
  gmailMessageId: string | undefined,
  isGmail: boolean,
): MessageKey {
  if (isGmail) {
    if (!gmailMessageId) throw new AdapterError('protocol', 'missing-gmail-message-id');
    return `gm:${gmailMessageId}`;
  }
  return `uid:${folderKey}:${uidValidity}:${uid}`;
}

export function normaliseHeaders(rawHeaders: Buffer | string): MessageHeaders {
  const headers = libmime.decodeHeaders(rawHeaders.toString());
  return {
    messageId: decodedFirst(headers['message-id']),
    inReplyTo: decodedFirst(headers['in-reply-to']),
    references: splitMessageIds(headers.references?.join(' ') ?? ''),
    subject: decodedFirst(headers.subject),
    from: parseAddresses(headers.from ?? [])[0] ?? null,
    to: parseAddresses(headers.to ?? []),
    cc: parseAddresses(headers.cc ?? []),
    date: parseHeaderDate(headers.date?.[0]),
  };
}

export function mapImapError(error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  const details = errorDetails(error);
  if (details.authenticationFailed || /AUTHENTICATIONFAILED/i.test(details.text)) {
    return new AdapterError('auth', details.message, { cause: error });
  }
  if (
    /THROTTLED|UNAVAILABLE|SERVERBUG/i.test(details.text) ||
    /TIMEOUT|TIMEDOUT|ECONN|EPIPE|ENET|EHOST|ENOTFOUND|EAI_AGAIN|SOCKET|CONNECT_TIMEOUT/i.test(
      details.code,
    )
  ) {
    return new AdapterError('transient', details.message, { cause: error });
  }
  return new AdapterError('protocol', details.message, { cause: error });
}

function folderFromListResponse(item: ListResponse, uidValidity: bigint | undefined): Folder {
  if (uidValidity === undefined) throw new AdapterError('protocol', 'missing-uidvalidity');
  return {
    folderKey: item.path,
    path: item.path,
    role: mapFolderRole(item.name, item.specialUse, item.flags),
    uidValidity: safeUidValidity(uidValidity),
  };
}

function currentUidValidity(mailbox: MailboxObject | false): number {
  if (!mailbox) throw new AdapterError('protocol', 'mailbox-not-open');
  return safeUidValidity(mailbox.uidValidity);
}

function safeUidValidity(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new AdapterError('protocol', 'invalid-uidvalidity');
  return number;
}

function parseUidMessageKey(
  messageKey: string,
): { folderKey: string; uidValidity: number; uid: number } | undefined {
  const match = /^uid:(.*):(\d+):(\d+)$/.exec(messageKey);
  if (!match) return undefined;
  return { folderKey: match[1], uidValidity: Number(match[2]), uid: Number(match[3]) };
}

function parseInternalDate(value: Date | string | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseHeaderDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function decodedFirst(values: string[] | undefined): string | null {
  const value = values?.[0];
  return value === undefined ? null : libmime.decodeWords(value);
}

function splitMessageIds(value: string): string[] {
  const bracketed = value.match(/<[^>]+>/g);
  if (bracketed) return bracketed;
  return value.trim() ? value.trim().split(/\s+/) : [];
}

function parseAddresses(lines: string[]): string[] {
  return splitAddressList(lines.join(',')).map((address) => {
    const match = /^(.*)<([^<>]+)>$/.exec(address.trim());
    if (!match) return libmime.decodeWords(address.trim().replace(/^"|"$/g, ''));
    const name = libmime.decodeWords(match[1].trim().replace(/^"|"$/g, ''));
    const mailbox = match[2].trim();
    return name ? `${name} <${mailbox}>` : mailbox;
  });
}

function splitAddressList(value: string): string[] {
  const addresses: string[] = [];
  let start = 0;
  let quoted = false;
  let angleDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"' && value[index - 1] !== '\\') quoted = !quoted;
    else if (!quoted && character === '<') angleDepth += 1;
    else if (!quoted && character === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (!quoted && angleDepth === 0 && character === ',') {
      if (value.slice(start, index).trim()) addresses.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (value.slice(start).trim()) addresses.push(value.slice(start).trim());
  return addresses;
}

function outgoingCommand(message: string): string | null {
  const match = /^\S+\s+(?:UID\s+)?([A-Z][A-Z0-9-]*)\b/i.exec(message.trim());
  return match?.[1]?.toUpperCase() ?? null;
}

function hasAttribute(values: Set<string> | undefined, expected: string): boolean {
  const target = expected.toLowerCase();
  return [...(values ?? [])].some((value) => value.toLowerCase() === target);
}

function lower(value: string): string {
  return value.toLowerCase();
}

function* batches<T>(items: T[], size: number): Generator<T[]> {
  for (let index = 0; index < items.length; index += size) yield items.slice(index, index + size);
}

async function readStream(stream: NodeJS.ReadableStream, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = limit - length;
    if (remaining <= 0) break;
    chunks.push(bytes.subarray(0, remaining));
    length += Math.min(bytes.length, remaining);
  }
  return Buffer.concat(chunks, length);
}

function errorDetails(error: unknown): {
  authenticationFailed: boolean;
  code: string;
  message: string;
  text: string;
} {
  if (!isRecord(error)) {
    const message = String(error);
    return { authenticationFailed: false, code: '', message, text: message };
  }
  const message = typeof error.message === 'string' ? error.message : String(error);
  const code = typeof error.code === 'string' ? error.code : '';
  const response = typeof error.response === 'string' ? error.response : '';
  const responseText = typeof error.responseText === 'string' ? error.responseText : '';
  const serverResponseCode =
    typeof error.serverResponseCode === 'string' ? error.serverResponseCode : '';
  return {
    authenticationFailed: error.authenticationFailed === true,
    code,
    message,
    text: [message, code, response, responseText, serverResponseCode].join(' '),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
