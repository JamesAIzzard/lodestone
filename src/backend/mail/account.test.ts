import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MailAccountTomlConfig } from '../config';
import { InMemoryCredentialStore } from './credential-store';
import { FakeMailAdapter } from './fake-adapter';
import { openManifest } from './manifest';
import { ensureDirs } from './mirror-files';
import { MailAccount, MailRemovalError, SyncScheduler } from './account';
import type { RoundOutcome } from './sync';
import { AdapterError } from './adapter';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('SyncScheduler', () => {
  it('coalesces overlapping triggers into one queued round', async () => {
    let release!: () => void;
    const firstRound = new Promise<void>((resolve) => (release = resolve));
    const run = vi
      .fn<() => Promise<RoundOutcome>>()
      .mockImplementationOnce(async () => {
        await firstRound;
        return 'completed';
      })
      .mockResolvedValue('completed');
    const scheduler = new SyncScheduler(run, 60_000, fakeTimers().options);

    const first = scheduler.syncNow();
    const second = scheduler.syncNow();
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it('backs off from 5 seconds to the 5 minute cap and resets after success', async () => {
    const timers = fakeTimers();
    const run = vi
      .fn<() => Promise<RoundOutcome>>()
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('completed');
    const scheduler = new SyncScheduler(run, 42_000, timers.options);

    await scheduler.syncNow();
    expect(timers.delays.at(-1)).toBe(5_000);
    await scheduler.syncNow();
    expect(timers.delays.at(-1)).toBe(10_000);
    await scheduler.syncNow();
    expect(timers.delays.at(-1)).toBe(42_000);
    await scheduler.stop();
  });

  it('caps jittered failure backoff at five minutes', async () => {
    const timers = fakeTimers(1);
    const scheduler = new SyncScheduler(async () => 'failed', 60_000, timers.options);
    for (let attempt = 0; attempt < 10; attempt += 1) await scheduler.syncNow();
    expect(Math.max(...timers.delays)).toBe(300_000);
    await scheduler.stop();
  });

  it('pauses after authentication failure until restarted', async () => {
    const timers = fakeTimers();
    const run = vi.fn<() => Promise<RoundOutcome>>().mockResolvedValue('auth-required');
    const scheduler = new SyncScheduler(run, 60_000, timers.options);
    await scheduler.syncNow();
    expect(timers.delays).toEqual([]);
    await scheduler.syncNow();
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.start();
    expect(timers.delays).toEqual([0]);
    await scheduler.stop();
  });
});

describe('MailAccount', () => {
  it('hides the silo until selection reconciliation and indexing complete', async () => {
    const fixture = await accountFixture();
    const availability: boolean[] = [];
    let statusCalls = 0;
    fixture.silo.setAvailable.mockImplementation((value) => availability.push(value));
    fixture.silo.getStatus.mockImplementation(async () => ({
      indexCaughtUp: ++statusCalls > 1,
    }));

    await fixture.account.applySelection({
      receivedAfter: null,
      mode: 'explicit',
      folderKeys: ['INBOX'],
    });

    expect(availability).toEqual([false, true]);
    expect(fixture.manifest.getState('selection_revision')).toBe('1');
    expect(fixture.account.status()).toMatchObject({
      selectionSummary: '1 selected folder',
      username: 'user@example.com',
      receivedAfter: 'unlimited',
      selectionMode: 'default',
      selectedFolders: [],
      syncIntervalSeconds: 300,
      folders: [{ folderKey: 'INBOX', path: 'INBOX', role: 'inbox', uidValidity: 1 }],
      isGmail: false,
    });
    await fixture.account.shutdown();
  });

  it('marks authentication failure and reconnects with a replacement credential', async () => {
    const fixture = await accountFixture({ saveCredential: false });
    await expect(fixture.account.syncNow()).resolves.toBe('auth-required');
    expect(fixture.account.status().syncState).toBe('reauthorisation-required');

    await fixture.account.reconnect({ kind: 'password', password: 'replacement' });
    await expect(fixture.account.syncNow()).resolves.toBe('completed');
    await fixture.account.shutdown();
  });

  it('deletes account artefacts and reports a retryable failed step', async () => {
    const failing = await accountFixture({ failRemovalFor: 'tmp' });
    await expect(failing.account.remove()).rejects.toEqual(
      expect.objectContaining<Partial<MailRemovalError>>({ step: 'delete-tmp' }),
    );
    expect(failing.account.status().removalFailedStep).toBe('delete-tmp');

    const successful = await accountFixture();
    await successful.account.remove();
    expect(fs.existsSync(successful.dirs.mirror)).toBe(false);
    expect(fs.existsSync(successful.dirs.tmp)).toBe(false);
    expect(fs.existsSync(successful.dirs.manifest)).toBe(false);
    expect(await successful.store.load('0123456789abcdef0123456789abcdef')).toBeNull();
  });
});

async function accountFixture(options: { saveCredential?: boolean; failRemovalFor?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-mail-account-'));
  temporaryDirectories.push(root);
  const dirs = {
    root,
    mirror: path.join(root, 'mirror'),
    tmp: path.join(root, 'tmp'),
    manifest: path.join(root, 'manifest.sqlite'),
  };
  await ensureDirs(dirs);
  const manifest = openManifest(dirs.manifest);
  const store = new InMemoryCredentialStore();
  const hash = '0123456789abcdef0123456789abcdef';
  if (options.saveCredential !== false) {
    await store.save(hash, { kind: 'password', password: 'secret' });
  }
  const adapter = new FakeMailAdapter({
    folders: [{ folderKey: 'INBOX', path: 'INBOX', role: 'inbox', uidValidity: 1 }],
  });
  const silo = {
    setAvailable: vi.fn<(available: boolean) => void>(),
    getStatus: vi.fn(async () => ({ indexCaughtUp: true })),
  };
  const config: MailAccountTomlConfig = {
    host: 'imap.example.com',
    port: 993,
    username: 'user@example.com',
    display_name: 'Example',
    credential_kind: 'password',
    silo_name: 'Mail: Example',
    received_after: 'unlimited',
    selection_mode: 'default',
    selected_folders: [],
    sync_interval_seconds: 300,
  };
  const account = new MailAccount({
    accountHash: hash,
    config,
    manifest,
    dirs,
    credentialStore: store,
    silo,
    adapterFactory: async (_config, credentials) => {
      if (!(await credentials.load(hash))) throw new AdapterError('auth');
      return adapter;
    },
    wait: async () => undefined,
    logSink: () => undefined,
    scheduler: fakeTimers().options,
    removePath: !options.failRemovalFor
      ? undefined
      : async (target, removeOptions) => {
          if (String(target).endsWith(options.failRemovalFor)) throw new Error('injected');
          await fs.promises.rm(target, removeOptions);
        },
  });
  return { account, manifest, store, silo, dirs };
}

function fakeTimers(random = 0.5) {
  const delays: number[] = [];
  const options = {
    setTimer: ((_: () => void, milliseconds: number) => {
      delays.push(milliseconds);
      return { milliseconds } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimer: vi.fn(),
    random: () => random,
  };
  return { delays, options };
}
