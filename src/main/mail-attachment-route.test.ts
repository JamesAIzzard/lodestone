import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MailAccount } from '../backend/mail/account';
import type { SiloManager } from '../backend/silo-manager';
import { resolveMailMirrorFile } from './mail-attachment-route';

const roots: string[] = [];

afterEach(() => {
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe('resolveMailMirrorFile', () => {
  it('resolves a direct mirror Markdown file to its managed account', () => {
    const fixture = routeFixture();

    expect(resolveMailMirrorFile(fixture.dependencies, fixture.filePath)).toEqual({
      account: fixture.account,
      fileName: 'message.md',
      siloName: 'Mail: Example',
    });
  });

  it.each([
    ['writable silo', { readOnly: false }],
    ['ordinary silo', { managedBy: undefined }],
    ['nested file', { nested: true }],
    ['non-Markdown file', { extension: '.txt' }],
    ['overlapping roots', { overlapping: true }],
  ])('rejects a %s as not-email', (_name, options) => {
    const fixture = routeFixture(options);
    expect(resolveMailMirrorFile(fixture.dependencies, fixture.filePath)).toMatchObject({
      code: 'not-email',
    });
  });

  it.each([
    ['stopped', { stopped: true }],
    ['unavailable', { available: false }],
    ['missing account', { missingAccount: true }],
  ])('reports an %s source as unavailable', (_name, options) => {
    const fixture = routeFixture(options);
    expect(resolveMailMirrorFile(fixture.dependencies, fixture.filePath)).toMatchObject({
      code: 'unavailable',
    });
  });
});

function routeFixture(
  options: {
    readOnly?: boolean;
    managedBy?: string;
    nested?: boolean;
    extension?: string;
    overlapping?: boolean;
    stopped?: boolean;
    available?: boolean;
    missingAccount?: boolean;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-mail-route-'));
  roots.push(root);
  const mirror = path.join(root, 'mirror');
  const directory = options.nested ? path.join(mirror, 'nested') : mirror;
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `message${options.extension ?? '.md'}`);
  fs.writeFileSync(filePath, 'message');
  const account = { readAttachment: vi.fn() } as unknown as MailAccount;
  const config = {
    indexedDirectories: options.overlapping ? [root, mirror] : [mirror],
    readOnly: options.readOnly ?? true,
    managedBy:
      options.managedBy === undefined && 'managedBy' in options
        ? undefined
        : (options.managedBy ?? 'mail:hash'),
  };
  const manager = {
    getConfig: () => config,
    isStopped: options.stopped ?? false,
    isAvailable: options.available ?? true,
  } as unknown as SiloManager;
  return {
    filePath,
    account,
    dependencies: {
      siloManagers: new Map([['Mail: Example', manager]]),
      mailAccounts: new Map(options.missingAccount ? [] : [['hash', account]]),
    },
  };
}
