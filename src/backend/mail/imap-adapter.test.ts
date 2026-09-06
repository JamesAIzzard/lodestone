import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type {
  FetchMessageObject,
  ImapFlowOptions,
  ListResponse,
  Logger,
  MailboxObject,
} from 'imapflow';
import { AdapterError } from './adapter';
import { MAX_ATTACHMENT_BYTES } from './attachment';
import {
  createCommandLogger,
  createImapAdapter,
  formMessageKey,
  mapFolderRole,
  mapImapError,
  normaliseHeaders,
  utcCalendarDay,
} from './imap-adapter';
import type { Folder } from './types';

describe('IMAP adapter helpers', () => {
  it('maps special-use attributes before case-insensitive folder names', () => {
    expect(mapFolderRole('INBOX', undefined, new Set(['\\Inbox']))).toBe('inbox');
    expect(mapFolderRole('Deleted', '\\Sent')).toBe('sent');
    expect(mapFolderRole('Archive')).toBe('archive');
    expect(mapFolderRole('Mailbox/Spam')).toBe('junk');
    expect(mapFolderRole('Projects')).toBe('other');
  });

  it('converts the cutoff to the start of its UTC calendar day', () => {
    expect(utcCalendarDay(new Date('2026-09-06T23:15:00-07:00')).toISOString()).toBe(
      '2026-09-07T00:00:00.000Z',
    );
  });

  it('forms regular and Gmail message keys', () => {
    expect(formMessageKey('Archive:2025', 42, 99, undefined, false)).toBe('uid:Archive:2025:42:99');
    expect(formMessageKey('[Gmail]/All Mail', 42, 99, '187654321', true)).toBe('gm:187654321');
    expect(() => formMessageKey('All Mail', 42, 99, undefined, true)).toThrowError(
      new AdapterError('protocol', 'missing-gmail-message-id'),
    );
  });

  it('normalises decoded headers, addresses and invalid dates', () => {
    const headers = normaliseHeaders(
      Buffer.from(
        [
          'Message-ID: <message@example.com>',
          'In-Reply-To: <parent@example.com>',
          'References: <first@example.com> <second@example.com>',
          'Subject: =?UTF-8?Q?Quarterly_=C2=A3_report?=',
          'From: "Doe, Jane" <jane@example.com>',
          'To: =?UTF-8?Q?Jos=C3=A9?= <jose@example.com>, plain@example.com',
          'Cc: Example Person <person@example.com>',
          'Date: definitely not a date',
          '',
          '',
        ].join('\r\n'),
      ),
    );

    expect(headers).toEqual({
      messageId: '<message@example.com>',
      inReplyTo: '<parent@example.com>',
      references: ['<first@example.com>', '<second@example.com>'],
      subject: 'Quarterly £ report',
      from: 'Doe, Jane <jane@example.com>',
      to: ['José <jose@example.com>', 'plain@example.com'],
      cc: ['Example Person <person@example.com>'],
      date: null,
    });
  });

  it('maps authentication and recoverable server failures by kind', () => {
    expect(mapImapError({ authenticationFailed: true, message: 'login rejected' }).kind).toBe(
      'auth',
    );
    expect(mapImapError({ response: 'NO [AUTHENTICATIONFAILED] bad password' }).kind).toBe('auth');
    expect(mapImapError({ code: 'ETIMEDOUT', message: 'socket timed out' }).kind).toBe('transient');
    expect(mapImapError({ serverResponseCode: 'THROTTLED' }).kind).toBe('transient');
    expect(mapImapError(new Error('malformed response')).kind).toBe('protocol');
  });

  it('allows only approved outgoing commands and requires PEEK body fetches', () => {
    const commands: string[] = [];
    const logger = createCommandLogger(commands, () => undefined);
    logger.debug({ src: 'c', msg: '1 UID FETCH 5 (UID BODY.PEEK[1]<0.20>)' });
    logger.debug({ src: 'c', msg: '2 EXAMINE INBOX' });

    expect(commands).toEqual(['FETCH', 'EXAMINE']);
    expect(() => logger.debug({ src: 'c', msg: '3 UID STORE 5 +FLAGS (\\Seen)' })).toThrow(
      /imap-command-not-allowed:STORE/,
    );
    expect(() => logger.debug({ src: 'c', msg: '4 UID FETCH 5 BODY[1]' })).toThrow(
      /imap-fetch-without-peek/,
    );
  });
});

describe('IMAP adapter with a stubbed ImapFlow client', () => {
  it('connects lazily once, lists UID batches of at most 500, and filters the exact cutoff', async () => {
    const client = new StubImapClient();
    client.listResponses = [listResponse('INBOX', '\\Inbox', 77n)];
    client.searchResponse = Array.from({ length: 501 }, (_, index) => index + 1);
    client.fetchResponses = client.searchResponse.map((uid) =>
      fetchedEntry(uid, uid === 1 ? '2026-09-06T11:59:59Z' : '2026-09-06T12:00:00Z'),
    );
    const adapter = adapterFor(client);

    expect(client.connect).not.toHaveBeenCalled();
    expect(client.options).toMatchObject({
      host: 'imap.example.com',
      port: 993,
      secure: true,
      disableAutoIdle: true,
      disableAutoEnable: true,
      disableBinary: true,
      connectionTimeout: 30_000,
      socketTimeout: 60_000,
    });
    const [folder] = await adapter.listFolders();
    client.mailbox.uidValidity = 77n;
    const onCount = vi.fn();
    const entries = await collect(
      adapter.listMessages(folder, new Date('2026-09-06T12:00:00Z'), onCount),
    );

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.search).toHaveBeenCalledWith(
      { since: new Date('2026-09-06T00:00:00.000Z') },
      { uid: true },
    );
    expect(client.fetch.mock.calls.map(([uids]) => uids.length)).toEqual([500, 1]);
    expect(entries).toHaveLength(500);
    expect(onCount).toHaveBeenCalledWith(501);
    expect(entries[0].messageKey).toBe('uid:INBOX:77:2');
    expect(client.locks.every((lock) => lock.readOnly)).toBe(true);
  });

  it('exposes only Gmail All Mail and omits draft-labelled entries', async () => {
    const client = new StubImapClient(['X-GM-EXT-1', 'CONDSTORE', 'QRESYNC']);
    client.listResponses = [
      listResponse('INBOX', '\\Inbox', 2n),
      listResponse('[Gmail]/All Mail', '\\All', 3n),
    ];
    client.searchResponse = [9, 10];
    client.fetchResponses = [
      fetchedEntry(9, '2026-09-06T12:00:00Z', '1009', new Set(['Inbox'])),
      fetchedEntry(10, '2026-09-06T12:00:00Z', '1010', new Set(['\\Draft'])),
    ];
    const adapter = adapterFor(client);

    const folders = await adapter.listFolders();
    client.mailbox.uidValidity = 3n;
    const entries = await collect(adapter.listMessages(folders[0]));

    expect(folders).toEqual([
      { folderKey: '[Gmail]/All Mail', path: '[Gmail]/All Mail', role: 'all', uidValidity: 3 },
    ]);
    expect(entries).toMatchObject([
      { messageKey: 'gm:1009', labels: ['Inbox'], seen: true, flagged: false },
    ]);
    expect(adapter.supportsCondstore).toBe(true);
    expect(adapter.supportsQresync).toBe(true);
  });

  it('releases the listing lock before yielding entries for message fetching', async () => {
    const client = new StubImapClient();
    client.searchResponse = [1];
    client.fetchResponses = [fetchedEntry(1, '2026-09-06T12:00:00Z')];
    const adapter = adapterFor(client);
    const folder: Folder = { folderKey: 'INBOX', path: 'INBOX', role: 'inbox', uidValidity: 1 };

    const iterator = adapter.listMessages(folder)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { messageKey: 'uid:INBOX:1:1' },
    });

    expect(client.locks).toHaveLength(2);
    expect(client.locks.every((lock) => lock.released)).toBe(true);
  });

  it('uses STATUS when LIST cannot return UIDVALIDITY inline', async () => {
    const client = new StubImapClient();
    const listed = listResponse('INBOX', '\\Inbox', 55n);
    delete listed.status;
    client.listResponses = [listed];
    client.statusUidValidity = 55n;
    const adapter = adapterFor(client);

    await expect(adapter.listFolders()).resolves.toMatchObject([{ uidValidity: 55 }]);
    expect(client.status).toHaveBeenCalledWith('INBOX', { uidValidity: true });
  });

  it('rejects a changed UIDVALIDITY before searching', async () => {
    const client = new StubImapClient();
    client.mailbox.uidValidity = 9n;
    const adapter = adapterFor(client);
    const folder: Folder = { folderKey: 'INBOX', path: 'INBOX', role: 'inbox', uidValidity: 8 };

    await expect(collect(adapter.listMessages(folder))).rejects.toMatchObject({
      kind: 'protocol',
      message: 'uidvalidity-changed',
    });
    expect(client.search).not.toHaveBeenCalled();
  });

  it('fetches only the selected body part and returns decoded HTML text', async () => {
    const client = new StubImapClient();
    client.fetchOneResponse = {
      seq: 1,
      uid: 4,
      bodyStructure: {
        type: 'multipart/alternative',
        childNodes: [{ part: '1', type: 'text/html', parameters: { charset: 'utf-8' }, size: 20 }],
      },
      headers: Buffer.from('Subject: Hello\r\nFrom: Jane <jane@example.com>\r\n\r\n'),
    };
    client.downloadBytes = Buffer.from('<p>Hello <b>world</b></p>');
    const adapter = adapterFor(client);

    const message = await adapter.fetchMessage('uid:INBOX:1:4');

    expect(client.fetchOne).toHaveBeenCalledWith(
      4,
      { bodyStructure: true, headers: true },
      { uid: true },
    );
    expect(client.download).toHaveBeenCalledWith(4, '1', {
      uid: true,
      maxBytes: 2 * 1024 * 1024,
    });
    expect(message).toMatchObject({
      bodyText: 'Hello world',
      bodyMime: 'text/html',
      bodyStatus: 'complete',
      headers: { subject: 'Hello', from: 'Jane <jane@example.com>' },
    });
  });

  it('resolves an uncached Gmail message ID after a process restart', async () => {
    const client = new StubImapClient(['X-GM-EXT-1']);
    client.mailbox.uidValidity = 3n;
    client.listResponses = [listResponse('[Gmail]/All Mail', '\\All', 3n)];
    client.searchResponse = [14];
    client.fetchOneResponse = {
      seq: 14,
      uid: 14,
      bodyStructure: { type: 'application/pdf', size: 40 },
      headers: Buffer.from('Subject: Persisted work\r\n\r\n'),
    };
    const adapter = adapterFor(client);

    const message = await adapter.fetchMessage('gm:987654321');

    expect(client.search).toHaveBeenCalledWith({ emailId: '987654321' }, { uid: true });
    expect(client.fetchOne).toHaveBeenCalledWith(
      14,
      { bodyStructure: true, headers: true },
      { uid: true },
    );
    expect(message.bodyStatus).toBe('unsupported');
  });

  it('maps a missing fetched UID', async () => {
    const client = new StubImapClient();
    client.fetchOneResponse = false;
    const adapter = adapterFor(client);

    await expect(adapter.fetchMessage('uid:INBOX:1:404')).rejects.toMatchObject({
      kind: 'not-found',
    });
  });

  it('fetches only the selected attachment section with one oversize sentinel byte', async () => {
    const client = new StubImapClient();
    client.fetchOneResponse = attachmentFetch();
    client.downloadBytes = Buffer.from('attachment bytes');
    const adapter = adapterFor(client);

    await expect(
      adapter.fetchAttachment('uid:INBOX:1:4', 2, {
        maxBytes: 32,
        expected: {
          count: 2,
          attachment: { name: 'photo.png', mime: 'image/png', size: 16 },
        },
      }),
    ).resolves.toMatchObject({
      bytes: client.downloadBytes,
      mime: 'image/png',
      name: 'photo.png',
      charset: null,
      declaredSize: 16,
    });
    expect(client.download).toHaveBeenCalledWith(4, '3', { uid: true, maxBytes: 33 });
  });

  it('rejects invalid ordinals and stale metadata without downloading a part', async () => {
    const client = new StubImapClient();
    client.fetchOneResponse = attachmentFetch();
    const adapter = adapterFor(client);
    const expected = {
      count: 2,
      attachment: { name: 'report.txt', mime: 'text/plain', size: 12 },
    };

    await expect(
      adapter.fetchAttachment('uid:INBOX:1:4', 0, { maxBytes: 50, expected }),
    ).rejects.toMatchObject({ kind: 'not-found' });
    await expect(
      adapter.fetchAttachment('uid:INBOX:1:4', 3, { maxBytes: 50, expected }),
    ).rejects.toMatchObject({ kind: 'not-found' });
    await expect(
      adapter.fetchAttachment('uid:INBOX:1:4', 1, {
        maxBytes: 50,
        expected: { ...expected, count: 3 },
      }),
    ).rejects.toMatchObject({ kind: 'stale' });
    await expect(
      adapter.fetchAttachment('uid:INBOX:1:4', 1, {
        maxBytes: 50,
        expected: { count: 2, attachment: { ...expected.attachment, name: 'other.txt' } },
      }),
    ).rejects.toMatchObject({ kind: 'stale' });
    expect(client.download).not.toHaveBeenCalled();
  });

  it('rejects declared and received oversize attachments without returning partial bytes', async () => {
    const client = new StubImapClient();
    client.fetchOneResponse = attachmentFetch(3 * MAX_ATTACHMENT_BYTES + 1);
    const adapter = adapterFor(client);
    await expect(
      adapter.fetchAttachment('uid:INBOX:1:4', 1, {
        maxBytes: MAX_ATTACHMENT_BYTES,
        expected: {
          count: 2,
          attachment: {
            name: 'report.txt',
            mime: 'text/plain',
            size: 3 * MAX_ATTACHMENT_BYTES + 1,
          },
        },
      }),
    ).rejects.toMatchObject({ kind: 'too-large' });
    expect(client.download).not.toHaveBeenCalled();

    client.fetchOneResponse = attachmentFetch(5);
    const oversizedStream = Readable.from([Buffer.alloc(5)]);
    const destroy = vi.spyOn(oversizedStream, 'destroy');
    client.downloadStream = oversizedStream;
    await expect(
      adapter.fetchAttachment('uid:INBOX:1:4', 1, {
        maxBytes: 4,
        expected: { count: 2, attachment: { name: 'report.txt', mime: 'text/plain', size: 5 } },
      }),
    ).rejects.toMatchObject({ kind: 'too-large' });
    expect(destroy).toHaveBeenCalled();

    client.downloadStream = null;
    client.downloadBytes = Buffer.alloc(4);
    client.fetchOneResponse = attachmentFetch(4);
    await expect(
      adapter.fetchAttachment('uid:INBOX:1:4', 1, {
        maxBytes: 4,
        expected: { count: 2, attachment: { name: 'report.txt', mime: 'text/plain', size: 4 } },
      }),
    ).resolves.toMatchObject({ bytes: Buffer.alloc(4) });
  });

  it('maps a missing message or empty download result to not-found', async () => {
    const client = new StubImapClient();
    const adapter = adapterFor(client);
    const options = {
      maxBytes: 50,
      expected: {
        count: 2,
        attachment: { name: 'report.txt', mime: 'text/plain', size: 12 },
      },
    };
    await expect(adapter.fetchAttachment('uid:INBOX:1:4', 1, options)).rejects.toMatchObject({
      kind: 'not-found',
    });

    client.fetchOneResponse = attachmentFetch();
    client.downloadMissing = true;
    await expect(adapter.fetchAttachment('uid:INBOX:1:4', 1, options)).rejects.toMatchObject({
      kind: 'not-found',
    });
  });

  it('gets an OAuth token immediately before connecting', async () => {
    const operations: string[] = [];
    const client = new StubImapClient();
    client.listResponses = [listResponse('INBOX', '\\Inbox', 1n)];
    client.connect.mockImplementation(async () => {
      operations.push('connect');
    });
    const accessToken = Object.assign(
      vi.fn(async () => {
        operations.push('token');
        return 'access-token';
      }),
      { invalidate: vi.fn() },
    );
    const adapter = createImapAdapter(
      {
        host: 'outlook.office365.com',
        port: 993,
        username: 'user@example.com',
        auth: { kind: 'xoauth2', accessToken },
        log: () => undefined,
      },
      (options) => {
        operations.push('client');
        client.options = options;
        return client;
      },
    );

    expect(operations).toEqual([]);
    await adapter.listFolders();

    expect(operations).toEqual(['token', 'client', 'connect']);
    expect(client.options?.auth).toEqual({ user: 'user@example.com', accessToken: 'access-token' });
  });

  it('invalidates and retries OAuth once after an authentication failure', async () => {
    const firstClient = new StubImapClient();
    const secondClient = new StubImapClient();
    secondClient.listResponses = [listResponse('INBOX', '\\Inbox', 1n)];
    firstClient.connect.mockRejectedValue({ authenticationFailed: true, message: 'expired' });
    const accessToken = Object.assign(
      vi.fn().mockResolvedValueOnce('stale-token').mockResolvedValueOnce('fresh-token'),
      { invalidate: vi.fn() },
    );
    const clients = [firstClient, secondClient];
    const authOptions: ImapFlowOptions['auth'][] = [];
    const adapter = createImapAdapter(
      {
        host: 'outlook.office365.com',
        port: 993,
        username: 'user@example.com',
        auth: { kind: 'xoauth2', accessToken },
        log: () => undefined,
      },
      (options) => {
        authOptions.push(options.auth);
        const client = clients.shift();
        if (!client) throw new Error('Unexpected client creation.');
        return client;
      },
    );

    await expect(adapter.listFolders()).resolves.toHaveLength(1);

    expect(accessToken).toHaveBeenCalledTimes(2);
    expect(accessToken.invalidate).toHaveBeenCalledTimes(1);
    expect(authOptions).toEqual([
      { user: 'user@example.com', accessToken: 'stale-token' },
      { user: 'user@example.com', accessToken: 'fresh-token' },
    ]);
  });

  it('returns auth after the one allowed OAuth retry also fails', async () => {
    const clients = [new StubImapClient(), new StubImapClient()];
    for (const client of clients) {
      client.connect.mockRejectedValue({ authenticationFailed: true, message: 'rejected' });
    }
    const accessToken = Object.assign(
      vi.fn(async () => 'access-token'),
      {
        invalidate: vi.fn(),
      },
    );
    const adapter = createImapAdapter(
      {
        host: 'outlook.office365.com',
        port: 993,
        username: 'user@example.com',
        auth: { kind: 'xoauth2', accessToken },
        log: () => undefined,
      },
      () => {
        const client = clients.shift();
        if (!client) throw new Error('Unexpected client creation.');
        return client;
      },
    );

    await expect(adapter.listFolders()).rejects.toMatchObject({ kind: 'auth' });
    expect(accessToken).toHaveBeenCalledTimes(2);
    expect(accessToken.invalidate).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh password client when the previous connection is unusable', async () => {
    const first = new StubImapClient();
    first.listResponses = [listResponse('INBOX', '\\Inbox', 1n)];
    const second = new StubImapClient();
    second.listResponses = [listResponse('INBOX', '\\Inbox', 1n)];
    const clients = [first, second];
    const adapter = createImapAdapter(
      {
        host: 'imap.example.com',
        port: 993,
        username: 'user@example.com',
        auth: { kind: 'password', password: 'secret' },
        log: () => undefined,
      },
      () => {
        const client = clients.shift();
        if (!client) throw new Error('Unexpected client creation.');
        return client;
      },
    );

    await adapter.listFolders();
    first.usable = false;
    await adapter.listFolders();

    expect(first.connect).toHaveBeenCalledTimes(1);
    expect(second.connect).toHaveBeenCalledTimes(1);
    expect(second.list).toHaveBeenCalledTimes(1);
  });

  it('logs out only after the connection has been used', async () => {
    const unusedClient = new StubImapClient();
    await adapterFor(unusedClient).close();
    expect(unusedClient.logout).not.toHaveBeenCalled();

    const client = new StubImapClient();
    client.listResponses = [listResponse('INBOX', '\\Inbox', 1n)];
    const adapter = adapterFor(client);
    await adapter.listFolders();
    await adapter.close();
    expect(client.logout).toHaveBeenCalledTimes(1);
  });
});

class StubImapClient {
  capabilities: Map<string, boolean | number>;
  usable = true;
  mailbox = mailbox(1n);
  listResponses: ListResponse[] = [];
  searchResponse: number[] | false = [];
  fetchResponses: FetchMessageObject[] = [];
  fetchOneResponse: FetchMessageObject | false = false;
  downloadBytes = Buffer.alloc(0);
  downloadStream: Readable | null = null;
  downloadMissing = false;
  statusUidValidity: bigint | undefined;
  logger: Logger | false | undefined;
  options: ImapFlowOptions | undefined;
  readonly locks: Array<{ path: string; readOnly: boolean; released: boolean }> = [];

  readonly connect = vi.fn(async () => undefined);
  readonly logout = vi.fn(async () => undefined);
  readonly on = vi.fn(() => this);
  readonly list = vi.fn(async () => this.listResponses);
  readonly status = vi.fn(async (path: string) => {
    const listed = this.listResponses.find((item) => item.path === path);
    return { uidValidity: listed?.status?.uidValidity ?? this.statusUidValidity };
  });
  readonly search = vi.fn(async () => this.searchResponse);
  readonly fetchOne = vi.fn(async () => this.fetchOneResponse);
  readonly download = vi.fn(async (): Promise<{ content: NodeJS.ReadableStream }> => {
    if (this.downloadMissing) return {} as { content: NodeJS.ReadableStream };
    return { content: this.downloadStream ?? Readable.from([this.downloadBytes]) };
  });
  readonly stats = vi.fn(() => ({ sent: 0, received: 0 }));

  constructor(capabilities: string[] = []) {
    this.capabilities = new Map(capabilities.map((capability) => [capability, true]));
  }

  readonly getMailboxLock = vi.fn(async (path: string, options: { readOnly: true }) => {
    const lock = { path, readOnly: options.readOnly, released: false };
    this.locks.push(lock);
    return { path, release: () => (lock.released = true) };
  });

  fetch = vi.fn(async function* (this: StubImapClient, uids: number[]) {
    const selected = new Set(uids);
    yield* this.fetchResponses.filter((response) => selected.has(response.uid));
  });
}

function adapterFor(client: StubImapClient) {
  return createImapAdapter(
    {
      host: 'imap.example.com',
      port: 993,
      username: 'user@example.com',
      auth: { kind: 'password', password: 'secret' },
      log: () => undefined,
    },
    (options: ImapFlowOptions) => {
      client.options = options;
      client.logger = options.logger;
      return client;
    },
  );
}

function mailbox(uidValidity: bigint): MailboxObject {
  return {
    path: 'INBOX',
    delimiter: '/',
    flags: new Set(),
    uidValidity,
    uidNext: 1,
    exists: 0,
  };
}

function listResponse(path: string, specialUse: string, uidValidity: bigint): ListResponse {
  return {
    path,
    pathAsListed: path,
    name: path.split('/').at(-1) ?? path,
    delimiter: '/',
    parent: [],
    parentPath: '',
    flags: new Set([specialUse]),
    specialUse,
    listed: true,
    subscribed: true,
    status: { path, uidValidity },
  };
}

function fetchedEntry(
  uid: number,
  internalDate: string,
  emailId?: string,
  labels?: Set<string>,
): FetchMessageObject {
  return {
    seq: uid,
    uid,
    internalDate,
    emailId,
    labels,
    flags: new Set(['\\Seen']),
  };
}

function attachmentFetch(firstSize = 12): FetchMessageObject {
  return {
    seq: 4,
    uid: 4,
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain' },
        {
          part: '2',
          type: 'text/plain',
          parameters: { charset: 'iso-8859-1' },
          disposition: 'attachment',
          dispositionParameters: { filename: 'report.txt' },
          size: firstSize,
        },
        {
          part: '3',
          type: 'image/png',
          disposition: 'attachment',
          dispositionParameters: { filename: 'photo.png' },
          size: 16,
        },
      ],
    },
  };
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const item of items) values.push(item);
  return values;
}
