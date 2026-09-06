import { rm } from 'node:fs/promises';

import type { MailAccountTomlConfig } from '../config';
import { accountUid } from './identity';
import type { Credential, CredentialStore } from './credential-store';
import { createImapAdapter } from './imap-adapter';
import { createAccessTokenSource } from './token-source';
import { MICROSOFT_THUNDERBIRD } from './oauth';
import type { MailAdapter } from './adapter';
import { AdapterError } from './adapter';
import type { Folder } from './types';
import type { Manifest } from './manifest';
import type { MirrorDirs } from './mirror-files';
import { Synchroniser, type MailSelection, type RoundOutcome } from './sync';
import { createMailLogger, type MailLogSink } from './logger';

export type MailSyncState =
  | 'initialising'
  | 'syncing'
  | 'idle'
  | 'reauthorisation-required'
  | 'error'
  | 'removing';

export interface MailAccountStatus {
  accountHash: string;
  siloName: string;
  displayName: string;
  credentialKind: 'password' | 'oauth';
  syncState: MailSyncState;
  lastRoundCompletedAt: string | null;
  lastError: string | null;
  messageCount: number;
  selectionSummary: string;
  username: string;
  oauthClientId?: string;
  receivedAfter: string;
  selectionMode: 'default' | 'explicit';
  selectedFolders: string[];
  syncIntervalSeconds: number;
  folders: Folder[];
  isGmail: boolean;
  removalFailedStep?: RemovalStep;
}

export interface MailSilo {
  setAvailable(available: boolean): void;
  getStatus(): Promise<{ indexCaughtUp: boolean }>;
}

export type MailAdapterFactory = (
  config: MailAccountTomlConfig,
  credentialStore: CredentialStore,
  accountHash: string,
  log: MailLogSink,
) => Promise<MailAdapter>;

export type RemovalStep =
  | 'stop-scheduler'
  | 'close-adapter'
  | 'close-manifest'
  | 'delete-mirror'
  | 'delete-tmp'
  | 'delete-manifest'
  | 'delete-credential'
  | 'stop-silo'
  | 'delete-index'
  | 'save-config'
  | 'delete-account-data';

export class MailRemovalError extends Error {
  constructor(
    public readonly step: RemovalStep,
    options?: ErrorOptions,
  ) {
    super(`Mail account removal failed at ${step}.`, options);
    this.name = 'MailRemovalError';
  }
}

export interface MailAccountOptions {
  accountHash: string;
  config: MailAccountTomlConfig;
  manifest: Manifest;
  dirs: MirrorDirs & { root: string; manifest: string };
  credentialStore: CredentialStore;
  silo: MailSilo;
  adapterFactory?: MailAdapterFactory;
  logSink?: MailLogSink;
  wait?: (milliseconds: number) => Promise<void>;
  scheduler?: Partial<SyncSchedulerOptions>;
  removePath?: typeof rm;
}

export class MailAccount {
  readonly accountHash: string;
  readonly config: MailAccountTomlConfig;

  private readonly manifest: Manifest;
  private readonly dirs: MailAccountOptions['dirs'];
  private readonly credentialStore: CredentialStore;
  private readonly silo: MailSilo;
  private readonly adapterFactory: MailAdapterFactory;
  private readonly log: MailLogSink;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly removePath: typeof rm;
  private readonly selection: MailSelection;
  private readonly scheduler: SyncScheduler;
  private adapter: MailAdapter | null = null;
  private synchroniser: Synchroniser | null = null;
  private manifestOpen = true;
  private removing = false;
  private removalFailedStep: RemovalStep | undefined;
  private cachedMessageCount = 0;
  private cachedLastCompleted: string | null = null;
  private cachedFolders: Folder[] = [];
  private selectionReconciliationPending = false;

  constructor(options: MailAccountOptions) {
    this.accountHash = options.accountHash;
    this.config = options.config;
    this.manifest = options.manifest;
    this.dirs = options.dirs;
    this.credentialStore = options.credentialStore;
    this.silo = options.silo;
    this.adapterFactory = options.adapterFactory ?? defaultAdapterFactory;
    this.log = createMailLogger(options.accountHash, options.logSink);
    this.wait =
      options.wait ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.removePath = options.removePath ?? rm;
    this.selection = {
      receivedAfter:
        options.config.received_after === 'unlimited'
          ? null
          : new Date(options.config.received_after),
      mode: options.config.selection_mode,
      folderKeys: [...options.config.selected_folders],
      revision: Number(options.manifest.getState('selection_revision') ?? '0'),
    };
    this.scheduler = new SyncScheduler(
      () => this.runRound(),
      options.config.sync_interval_seconds * 1_000,
      options.scheduler,
    );
  }

  start(): void {
    this.scheduler.start();
  }

  syncNow(): Promise<RoundOutcome> {
    if (this.selectionReconciliationPending) return this.resumeSelectionReconciliation();
    return this.scheduler.syncNow();
  }

  status(): MailAccountStatus {
    if (this.manifestOpen) {
      this.cachedMessageCount = this.manifest.messageCount();
      this.cachedLastCompleted = this.manifest.getState('last_round_completed_at');
      this.cachedFolders = this.manifest.folders().map((folder) => ({
        folderKey: folder.folderKey,
        path: folder.path,
        role: folder.role,
        uidValidity: folder.uidValidity,
      }));
    }
    return {
      accountHash: this.accountHash,
      siloName: this.config.silo_name,
      displayName: this.config.display_name,
      credentialKind: this.config.credential_kind,
      syncState: this.removing
        ? 'removing'
        : this.removalFailedStep
          ? 'error'
          : ((this.state('sync_state') ?? 'initialising') as MailSyncState),
      lastRoundCompletedAt: this.cachedLastCompleted,
      lastError: this.removalFailedStep
        ? `remove:${this.removalFailedStep}`
        : this.state('last_error'),
      messageCount: this.cachedMessageCount,
      selectionSummary: this.selectionSummary(),
      username: this.config.username,
      oauthClientId: this.config.oauth_client_id,
      receivedAfter: this.config.received_after,
      selectionMode: this.config.selection_mode,
      selectedFolders: [...this.config.selected_folders],
      syncIntervalSeconds: this.config.sync_interval_seconds,
      folders: this.cachedFolders,
      isGmail:
        this.cachedFolders.some((folder) => folder.role === 'all') ||
        this.config.host.toLowerCase() === 'imap.gmail.com',
      removalFailedStep: this.removalFailedStep,
    };
  }

  setSyncInterval(seconds: number): void {
    this.config.sync_interval_seconds = seconds;
    this.scheduler.setInterval(seconds * 1_000);
  }

  async applySelection(next: {
    receivedAfter: Date | null;
    mode: 'default' | 'explicit';
    folderKeys: string[];
  }): Promise<void> {
    await this.scheduler.stop();
    this.selection.receivedAfter = next.receivedAfter;
    this.selection.mode = next.mode;
    this.selection.folderKeys = [...next.folderKeys];
    this.selection.revision += 1;
    this.manifest.setState('selection_revision', String(this.selection.revision));

    this.selectionReconciliationPending = true;
    const outcome = await this.resumeSelectionReconciliation();
    if (outcome !== 'completed') throw new Error(`Mail reconciliation ${outcome}.`);
  }

  private async resumeSelectionReconciliation(): Promise<RoundOutcome> {
    await this.scheduler.stop();
    this.silo.setAvailable(false);
    for (;;) {
      const outcome = await this.runRound();
      if (outcome === 'budget-exhausted') {
        await this.wait(1_000);
        continue;
      }
      if (outcome !== 'completed') {
        if (outcome === 'auth-required') {
          this.manifest.setState('sync_state', 'reauthorisation-required');
        }
        return outcome;
      }
      break;
    }

    while (!(await this.silo.getStatus()).indexCaughtUp) await this.wait(100);
    this.silo.setAvailable(true);
    this.selectionReconciliationPending = false;
    this.scheduler.start();
    return 'completed';
  }

  async reconnect(credential: Credential): Promise<void> {
    await this.scheduler.stop();
    await this.closeAdapter();
    await this.credentialStore.save(this.accountHash, credential);
    this.manifest.deleteState('last_error');
    this.manifest.setState('sync_state', 'initialising');
    if (this.selectionReconciliationPending) {
      const outcome = await this.resumeSelectionReconciliation();
      if (outcome !== 'completed') throw new Error(`Mail reconciliation ${outcome}.`);
    } else {
      this.scheduler.start();
    }
  }

  async shutdown(): Promise<void> {
    await this.scheduler.stop();
    await this.closeAdapter();
    if (this.manifestOpen) {
      this.manifest.close();
      this.manifestOpen = false;
    }
  }

  async remove(): Promise<void> {
    this.removing = true;
    this.silo.setAvailable(false);
    try {
      await this.removalStep('stop-scheduler', () => this.scheduler.stop());
      await this.removalStep('close-adapter', () => this.closeAdapter());
      await this.removalStep('close-manifest', async () => {
        if (!this.manifestOpen) return;
        this.cachedMessageCount = this.manifest.messageCount();
        this.cachedLastCompleted = this.manifest.getState('last_round_completed_at');
        this.manifest.close();
        this.manifestOpen = false;
      });
      await this.removalStep('delete-mirror', () =>
        this.removePath(this.dirs.mirror, { recursive: true, force: true }),
      );
      await this.removalStep('delete-tmp', () =>
        this.removePath(this.dirs.tmp, { recursive: true, force: true }),
      );
      await this.removalStep('delete-manifest', async () => {
        await Promise.all(
          ['', '-wal', '-shm'].map((suffix) =>
            this.removePath(this.dirs.manifest + suffix, { force: true }),
          ),
        );
      });
      await this.removalStep('delete-credential', () =>
        this.credentialStore.delete(this.accountHash),
      );
      this.removalFailedStep = undefined;
    } finally {
      this.removing = false;
    }
  }

  recordRemovalFailure(step: RemovalStep): void {
    this.removalFailedStep = step;
  }

  private async runRound(): Promise<RoundOutcome> {
    try {
      if (!this.synchroniser) await this.createSynchroniser();
      const synchroniser = this.synchroniser;
      if (!synchroniser) throw new Error('Mail synchroniser was not created.');
      return await synchroniser.runRound();
    } catch (error) {
      const outcome =
        error instanceof AdapterError && error.kind === 'auth' ? 'auth-required' : 'failed';
      this.manifest.setState(
        'sync_state',
        outcome === 'auth-required' ? 'reauthorisation-required' : 'error',
      );
      this.manifest.setState('last_error', error instanceof AdapterError ? error.kind : 'internal');
      return outcome;
    }
  }

  private async createSynchroniser(): Promise<void> {
    this.adapter = await this.adapterFactory(
      this.config,
      this.credentialStore,
      this.accountHash,
      this.log,
    );
    this.synchroniser = new Synchroniser({
      adapter: this.adapter,
      manifest: this.manifest,
      dirs: this.dirs,
      accountUid: accountUid(this.config.host, this.config.port, this.config.username),
      selection: this.selection,
      log: (event, details) => this.log(event, details),
    });
  }

  private async closeAdapter(): Promise<void> {
    const adapter = this.adapter;
    this.adapter = null;
    this.synchroniser = null;
    if (adapter) await adapter.close();
  }

  private state(key: string): string | null {
    return this.manifestOpen ? this.manifest.getState(key) : null;
  }

  private selectionSummary(): string {
    if (
      this.manifestOpen &&
      this.manifest.selectedFolders().some((folder) => folder.role === 'all')
    ) {
      return 'All Mail';
    }
    return this.selection.mode === 'default'
      ? 'All folders except Drafts, Junk and Trash'
      : `${this.selection.folderKeys.length} selected folder${this.selection.folderKeys.length === 1 ? '' : 's'}`;
  }

  private async removalStep(step: RemovalStep, action: () => Promise<void>): Promise<void> {
    try {
      await action();
      if (this.removalFailedStep === step) this.removalFailedStep = undefined;
    } catch (error) {
      this.removalFailedStep = step;
      throw new MailRemovalError(step, { cause: error });
    }
  }
}

export interface SyncSchedulerOptions {
  setTimer: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  random: () => number;
}

export class SyncScheduler {
  private intervalMs: number;
  private readonly timers: SyncSchedulerOptions;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<RoundOutcome> | null = null;
  private queued = false;
  private stopped = true;
  private authPaused = false;
  private failedAttempts = 0;

  constructor(
    private readonly runRound: () => Promise<RoundOutcome>,
    intervalMs: number,
    timers: Partial<SyncSchedulerOptions> = {},
  ) {
    this.intervalMs = intervalMs;
    this.timers = {
      setTimer: timers.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds)),
      clearTimer: timers.clearTimer ?? clearTimeout,
      random: timers.random ?? Math.random,
    };
  }

  start(): void {
    this.stopped = false;
    this.authPaused = false;
    this.schedule(0);
  }

  setInterval(milliseconds: number): void {
    this.intervalMs = milliseconds;
    if (!this.stopped && !this.authPaused && !this.running) this.schedule(milliseconds);
  }

  syncNow(): Promise<RoundOutcome> {
    if (this.authPaused) return Promise.resolve('auth-required');
    this.stopped = false;
    this.clearScheduled();
    return this.trigger();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.queued = false;
    this.clearScheduled();
    await this.running;
  }

  private trigger(): Promise<RoundOutcome> {
    if (this.running) {
      this.queued = true;
      return this.running;
    }
    const running = this.drain();
    this.running = running;
    void running.finally(() => {
      if (this.running === running) this.running = null;
    });
    return running;
  }

  private async drain(): Promise<RoundOutcome> {
    let outcome: RoundOutcome;
    do {
      this.queued = false;
      try {
        outcome = await this.runRound();
      } catch {
        outcome = 'failed';
      }
      if (outcome === 'auth-required') {
        this.authPaused = true;
        this.queued = false;
      }
    } while (this.queued && !this.stopped && !this.authPaused);

    if (!this.stopped && !this.authPaused) this.scheduleAfter(outcome);
    return outcome;
  }

  private scheduleAfter(outcome: RoundOutcome): void {
    if (outcome === 'completed') {
      this.failedAttempts = 0;
      this.schedule(this.intervalMs);
      return;
    }
    if (outcome === 'budget-exhausted') {
      this.schedule(1_000);
      return;
    }
    if (outcome === 'failed') {
      const base = Math.min(5_000 * 2 ** this.failedAttempts, 300_000);
      this.failedAttempts += 1;
      this.schedule(Math.min(300_000, Math.round(base * (0.5 + this.timers.random()))));
    }
  }

  private schedule(milliseconds: number): void {
    this.clearScheduled();
    this.timer = this.timers.setTimer(() => {
      this.timer = null;
      void this.trigger();
    }, milliseconds);
  }

  private clearScheduled(): void {
    if (this.timer === null) return;
    this.timers.clearTimer(this.timer);
    this.timer = null;
  }
}

async function defaultAdapterFactory(
  config: MailAccountTomlConfig,
  store: CredentialStore,
  accountHash: string,
  log: MailLogSink,
): Promise<MailAdapter> {
  const credential = await store.load(accountHash);
  if (!credential || credential.kind !== config.credential_kind) {
    throw new AdapterError('auth', 'credential-missing');
  }
  const auth =
    credential.kind === 'password'
      ? ({ kind: 'password', password: credential.password } as const)
      : ({
          kind: 'xoauth2',
          accessToken: createAccessTokenSource(
            { ...MICROSOFT_THUNDERBIRD, clientId: config.oauth_client_id ?? credential.clientId },
            store,
            accountHash,
          ),
        } as const);
  return createImapAdapter({
    host: config.host,
    port: config.port,
    username: config.username,
    auth,
    log,
  });
}
