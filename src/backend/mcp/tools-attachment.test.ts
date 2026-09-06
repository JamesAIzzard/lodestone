import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { AttachmentFetchErrorCode, AttachmentFetchResponse } from '../mail/attachment';
import { PuidManager } from './puid-manager';
import { readEmailAttachment } from './tools-attachment';
import type { McpServerDeps } from './types';
import type { SiloStatus } from '../../shared/types';

describe('readEmailAttachment', () => {
  it.each(['d1', 'C:\\mail\\message.md', 'r999'])(
    'rejects invalid or unknown reference %s without a GUI read',
    async (email) => {
      const fixture = toolFixture();
      const result = await readEmailAttachment(
        { email, attachment: 1 },
        fixture.deps,
        fixture.puid,
      );
      expect(firstText(result)).toMatch(/^Error:/);
      expect(fixture.readAttachment).not.toHaveBeenCalled();
    },
  );

  it('rejects invalidated and non-mail references without a GUI read', async () => {
    const invalidated = toolFixture();
    invalidated.puid.invalidatePuid(invalidated.email);
    expect(
      firstText(
        await readEmailAttachment(
          { email: invalidated.email, attachment: 1 },
          invalidated.deps,
          invalidated.puid,
        ),
      ),
    ).toContain('invalidated');
    expect(invalidated.readAttachment).not.toHaveBeenCalled();

    const ordinary = toolFixture({ managedBy: undefined });
    expect(
      firstText(
        await readEmailAttachment(
          { email: ordinary.email, attachment: 1 },
          ordinary.deps,
          ordinary.puid,
        ),
      ),
    ).toContain('not a mirrored email');
    expect(ordinary.readAttachment).not.toHaveBeenCalled();
  });

  it('renders decoded text with the reference, ordinal and attachment metadata', async () => {
    const fixture = toolFixture({
      response: {
        kind: 'attachment',
        dataBase64: Buffer.from('hello ``` world').toString('base64'),
        mime: 'text/plain',
        name: null,
        charset: 'utf-8',
        size: 15,
      },
    });
    const result = await readEmailAttachment(
      { email: fixture.email, attachment: 1 },
      fixture.deps,
      fixture.puid,
    );

    expect(firstText(result)).toContain(
      `## ${fixture.email} attachment 1: (unnamed) (text/plain, 15 B)`,
    );
    expect(firstText(result)).toContain('hello ``` world');
    expect(fixture.notifyActivity).toHaveBeenCalledWith({
      channel: 'silo',
      siloName: 'Mail: Example',
    });
  });

  it('returns raster content as an MCP image block', async () => {
    const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const fixture = toolFixture({
      response: {
        kind: 'attachment',
        dataBase64: bytes.toString('base64'),
        mime: 'image/png',
        name: 'map.png',
        charset: null,
        size: bytes.length,
      },
    });
    const result = await readEmailAttachment(
      { email: fixture.email, attachment: 1 },
      fixture.deps,
      fixture.puid,
    );

    expect(result.content[1]).toEqual({
      type: 'image',
      data: bytes.toString('base64'),
      mimeType: 'image/png',
    });
  });

  it.each<AttachmentFetchErrorCode>([
    'not-email',
    'unavailable',
    'not-found',
    'stale',
    'too-large',
    'encrypted',
    'unsupported',
    'auth',
    'transient',
    'protocol',
  ])('renders %s as a safe actionable error', async (code) => {
    const fixture = toolFixture({
      response: { kind: 'error', code, message: 'raw server details' },
    });
    const text = firstText(
      await readEmailAttachment(
        { email: fixture.email, attachment: 1 },
        fixture.deps,
        fixture.puid,
      ),
    );
    expect(text).toMatch(/^Error: .+;/);
    expect(text).not.toContain('raw server details');
  });
});

function toolFixture(options: { managedBy?: string; response?: AttachmentFetchResponse } = {}) {
  const puid = new PuidManager();
  const filePath = path.resolve('mail', 'message.md');
  const email = puid.assignFilePuid(filePath);
  const readAttachment = vi.fn(
    async () =>
      options.response ??
      ({
        kind: 'attachment',
        dataBase64: Buffer.from('text').toString('base64'),
        mime: 'text/plain',
        name: 'note.txt',
        charset: 'utf-8',
        size: 4,
      } as const),
  );
  const notifyActivity = vi.fn();
  const status = {
    config: {
      name: 'Mail: Example',
      indexedDirectories: [path.dirname(filePath)],
      managedBy:
        options.managedBy === undefined && 'managedBy' in options
          ? undefined
          : (options.managedBy ?? 'mail:hash'),
    },
    available: true,
  } as SiloStatus;
  const deps = {
    silo: { status: async () => ({ silos: [status] }) },
    mail: { readAttachment },
    notifyActivity,
  } as unknown as McpServerDeps;
  return { puid, email, deps, readAttachment, notifyActivity };
}

function firstText(result: Awaited<ReturnType<typeof readEmailAttachment>>): string {
  const first = result.content[0];
  return first.type === 'text' ? first.text : '';
}
