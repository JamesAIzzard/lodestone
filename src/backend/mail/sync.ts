import { accountHash, mirrorFileName } from './identity';
import { contentHash, renderMirrorFile } from './markdown-writer';
import type { MailAdapter } from './adapter';
import { AdapterError } from './adapter';
import type { Manifest } from './manifest';
import { cleanTmp, deleteMirrorFile, writeMirrorFile, type MirrorDirs } from './mirror-files';
import type { AccountUid, Entry, Folder, MessageKey } from './types';

export interface MailSelection {
  receivedAfter: Date | null;
  mode: 'default' | 'explicit';
  folderKeys: string[];
  revision: number;
}

export type RoundOutcome = 'completed' | 'budget-exhausted' | 'auth-required' | 'failed';

export type MailLog = (
  event: string,
  details: { account_hash: string; round: number; [key: string]: string | number | boolean },
) => void;

export interface MirrorFileOperations {
  cleanTmp: typeof cleanTmp;
  writeMirrorFile: typeof writeMirrorFile;
  deleteMirrorFile: typeof deleteMirrorFile;
}

export interface SynchroniserOptions {
  adapter: MailAdapter;
  manifest: Manifest;
  dirs: MirrorDirs;
  accountUid: AccountUid;
  selection: MailSelection;
  budgetMs?: number;
  clock?: () => Date;
  log?: MailLog;
  fileOperations?: MirrorFileOperations;
}

export class Synchroniser {
  private readonly adapter: MailAdapter;
  private readonly manifest: Manifest;
  private readonly dirs: MirrorDirs;
  private readonly accountUid: AccountUid;
  private readonly accountHash: string;
  private readonly selection: MailSelection;
  private readonly budgetMs: number;
  private readonly clock: () => Date;
  private readonly log: MailLog;
  private readonly files: MirrorFileOperations;
  private readonly ready: Promise<void>;
  private activeRound: Promise<RoundOutcome> | null = null;

  constructor(options: SynchroniserOptions) {
    this.adapter = options.adapter;
    this.manifest = options.manifest;
    this.dirs = options.dirs;
    this.accountUid = options.accountUid;
    this.accountHash = accountHash(options.accountUid);
    this.selection = options.selection;
    this.budgetMs = options.budgetMs ?? 60_000;
    this.clock = options.clock ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
    this.files = options.fileOperations ?? { cleanTmp, writeMirrorFile, deleteMirrorFile };
    this.ready = this.files.cleanTmp(this.dirs);
  }

  runRound(): Promise<RoundOutcome> {
    if (this.activeRound) return this.activeRound;
    const round = this.executeRound();
    this.activeRound = round;
    const clear = () => {
      if (this.activeRound === round) this.activeRound = null;
    };
    void round.then(clear, clear);
    return round;
  }

  private async executeRound(): Promise<RoundOutcome> {
    await this.ready;
    const round = Number(this.manifest.getState('current_round') ?? '1');
    const startedAt = this.clock().getTime();
    this.manifest.setState('sync_state', 'syncing');
    this.log('mail-sync-started', { account_hash: this.accountHash, round });

    try {
      const pendingFinalisation = this.pendingFinalisation(round);
      if (pendingFinalisation) {
        const outcome = await this.finaliseRound(round, startedAt, pendingFinalisation);
        return outcome;
      }

      const folders = await this.adapter.listFolders();
      const beforeMemberships = membershipSignatures(this.manifest);
      this.reconcileFolders(folders);
      const renderedMemberships = new Map<MessageKey, string>();
      let listingFailed = false;

      for (const folder of this.manifest.selectedFolders()) {
        try {
          const sourceFolder: Folder = {
            folderKey: folder.folderKey,
            path: folder.path,
            role: folder.role,
            uidValidity: folder.uidValidity,
          };
          for await (const entry of this.adapter.listMessages(
            sourceFolder,
            this.selection.receivedAfter,
          )) {
            if (this.selection.receivedAfter && entry.receivedAt < this.selection.receivedAfter)
              continue;
            if (this.adapter.isGmail && entry.labels?.includes('\\Draft')) continue;
            const previousMembership = this.manifest.membership(entry.messageKey, folder.folderKey);
            const previousMessage = this.manifest.message(entry.messageKey);
            this.manifest.upsertMembership({
              messageKey: entry.messageKey,
              folderKey: folder.folderKey,
              seen: entry.seen,
              flagged: entry.flagged,
              seenInRound: round,
            });
            const changed =
              !previousMessage ||
              !previousMembership ||
              previousMembership.seen !== entry.seen ||
              previousMembership.flagged !== entry.flagged ||
              !sameLabels(previousMessage.labels, entry.labels);
            if (!changed) continue;
            if (this.budgetExpired(startedAt)) return this.finish(round, 'budget-exhausted');
            const outcome = await this.renderEntry(entry);
            if (outcome) return this.finish(round, outcome);
            renderedMemberships.set(
              entry.messageKey,
              membershipSignature(this.manifest, entry.messageKey),
            );
          }
          this.manifest.markListingComplete(folder.folderKey, round);
          this.manifest.deleteUnseenMembership(folder.folderKey, round);
        } catch (error) {
          const outcome = classifyError(error);
          if (outcome === 'auth-required') return this.finish(round, outcome);
          listingFailed = true;
          this.log('mail-folder-list-failed', {
            account_hash: this.accountHash,
            round,
            error_kind: errorKind(error),
          });
        }
      }

      if (listingFailed || !this.manifest.allSelectedFoldersComplete(round)) {
        return this.finish(round, 'failed');
      }

      const changedMessages = changedMembershipMessages(
        beforeMemberships,
        renderedMemberships,
        this.manifest,
      );
      this.savePendingFinalisation(round, changedMessages);
      const outcome = await this.finaliseRound(round, startedAt, changedMessages);
      return outcome;
    } catch (error) {
      return this.finish(round, classifyError(error), error);
    }
  }

  private async finaliseRound(
    round: number,
    startedAt: number,
    messageKeys: MessageKey[],
  ): Promise<RoundOutcome> {
    for (let index = 0; index < messageKeys.length; index += 1) {
      const messageKey = messageKeys[index];
      if (
        this.manifest.message(messageKey) &&
        this.manifest.membershipsForMessage(messageKey).length > 0
      ) {
        if (this.budgetExpired(startedAt)) return this.finish(round, 'budget-exhausted');
        const outcome = await this.renderExistingMessage(messageKey);
        if (outcome) return this.finish(round, outcome);
      }
      this.savePendingFinalisation(round, messageKeys.slice(index + 1));
    }

    for (const message of this.manifest.messagesWithoutMembership()) {
      await this.files.deleteMirrorFile(this.dirs, message.fileName);
      this.manifest.deleteMessage(message.messageKey);
    }

    this.manifest.setState('last_round_completed_at', this.clock().toISOString());
    this.manifest.setState('current_round', String(round + 1));
    this.manifest.deleteState('pending_finalisation');
    this.manifest.deleteState('last_error');
    return this.finish(round, 'completed');
  }

  private pendingFinalisation(round: number): MessageKey[] | null {
    const encoded = this.manifest.getState('pending_finalisation');
    if (!encoded) return null;
    const pending = JSON.parse(encoded) as { round: number; messageKeys: MessageKey[] };
    return pending.round === round ? pending.messageKeys : null;
  }

  private savePendingFinalisation(round: number, messageKeys: MessageKey[]): void {
    this.manifest.setState('pending_finalisation', JSON.stringify({ round, messageKeys }));
  }

  private reconcileFolders(folders: Folder[]): void {
    const present = new Set(folders.map((folder) => folder.folderKey));
    const selected = new Set(
      folders.filter((folder) => this.isSelected(folder)).map((folder) => folder.folderKey),
    );
    this.manifest.deleteFoldersExcept([...present]);
    for (const folder of folders) {
      const previousUidValidity = this.manifest.folderUidValidity(folder.folderKey);
      if (previousUidValidity !== null && previousUidValidity !== folder.uidValidity) {
        this.manifest.resetFolder(folder.folderKey);
      }
      this.manifest.upsertFolder({ ...folder, selected: selected.has(folder.folderKey) });
    }
    const deselected = folders
      .filter((folder) => !selected.has(folder.folderKey))
      .map((folder) => folder.folderKey);
    this.manifest.deleteMembershipForFolders(deselected);
    this.manifest.setState('selection_revision', String(this.selection.revision));
  }

  private isSelected(folder: Folder): boolean {
    if (folder.role === 'drafts') return false;
    if (this.adapter.isGmail) return folder.role === 'all';
    if (this.selection.mode === 'explicit')
      return this.selection.folderKeys.includes(folder.folderKey);
    return folder.role !== 'junk' && folder.role !== 'trash';
  }

  private async renderEntry(entry: Entry): Promise<RoundOutcome | null> {
    return this.renderMessage(entry.messageKey, entry.receivedAt, entry.labels);
  }

  private async renderExistingMessage(messageKey: MessageKey): Promise<RoundOutcome | null> {
    const record = this.manifest.message(messageKey);
    if (!record) return null;
    return this.renderMessage(messageKey, new Date(record.receivedAt), record.labels ?? undefined);
  }

  private async renderMessage(
    messageKey: MessageKey,
    receivedAt: Date,
    labels: string[] | undefined,
  ): Promise<RoundOutcome | null> {
    try {
      const message = await this.adapter.fetchMessage(messageKey);
      const memberships = this.manifest.membershipsForMessage(messageKey);
      const folders = this.adapter.isGmail
        ? [...(labels ?? [])].sort()
        : memberships.map((item) => item.path);
      const rendered = renderMirrorFile({
        ...message,
        accountUid: this.accountUid,
        messageKey,
        receivedAt,
        folders,
        seen: memberships.length > 0 && memberships.every((item) => item.seen),
        flagged: memberships.some((item) => item.flagged),
      });
      const hash = contentHash(rendered);
      const existing = this.manifest.message(messageKey);
      const fileName = existing?.fileName ?? mirrorFileName(this.accountUid, messageKey);
      if (existing?.contentHash !== hash)
        await this.files.writeMirrorFile(this.dirs, fileName, rendered);
      const fetchedAt = this.clock().toISOString();
      if (existing) this.manifest.updateMessageHash(messageKey, hash, labels ?? null, fetchedAt);
      else {
        this.manifest.insertMessage({
          messageKey,
          fileName,
          receivedAt: receivedAt.toISOString(),
          labels: labels ?? null,
          contentHash: hash,
          fetchedAt,
        });
      }
      return null;
    } catch (error) {
      if (error instanceof AdapterError && error.kind === 'not-found') {
        for (const membership of this.manifest.membershipsForMessage(messageKey)) {
          this.manifest.deleteMembership(messageKey, membership.folderKey);
        }
        return null;
      }
      return classifyError(error);
    }
  }

  private budgetExpired(startedAt: number): boolean {
    return this.clock().getTime() - startedAt >= this.budgetMs;
  }

  private finish(round: number, outcome: RoundOutcome, error?: unknown): RoundOutcome {
    this.manifest.setState(
      'sync_state',
      outcome === 'auth-required'
        ? 'reauthorisation-required'
        : outcome === 'completed'
          ? 'idle'
          : outcome === 'budget-exhausted'
            ? 'syncing'
            : 'error',
    );
    if (error) this.manifest.setState('last_error', errorKind(error));
    this.log('mail-sync-finished', { account_hash: this.accountHash, round, outcome });
    return outcome;
  }
}

function membershipSignatures(manifest: Manifest): Map<MessageKey, string> {
  return new Map(
    manifest
      .messages()
      .map((message) => [message.messageKey, membershipSignature(manifest, message.messageKey)]),
  );
}

function changedMembershipMessages(
  before: Map<MessageKey, string>,
  rendered: Map<MessageKey, string>,
  manifest: Manifest,
): MessageKey[] {
  return manifest
    .messages()
    .filter(
      (message) =>
        (rendered.get(message.messageKey) ?? before.get(message.messageKey)) !==
        membershipSignature(manifest, message.messageKey),
    )
    .map((message) => message.messageKey);
}

function membershipSignature(manifest: Manifest, messageKey: MessageKey): string {
  return JSON.stringify(
    manifest.membershipsForMessage(messageKey).map(({ folderKey, path, seen, flagged }) => ({
      folderKey,
      path,
      seen,
      flagged,
    })),
  );
}

function sameLabels(stored: string[] | null, current: string[] | undefined): boolean {
  return JSON.stringify([...(stored ?? [])].sort()) === JSON.stringify([...(current ?? [])].sort());
}

function classifyError(error: unknown): RoundOutcome {
  if (error instanceof AdapterError && error.kind === 'auth') return 'auth-required';
  return 'failed';
}

function errorKind(error: unknown): string {
  return error instanceof AdapterError ? error.kind : 'internal';
}
