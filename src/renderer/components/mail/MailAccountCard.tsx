import { useState } from 'react';
import {
  AlertTriangle,
  ExternalLink,
  Loader2,
  Mail,
  RefreshCw,
  Settings,
  Trash2,
  Unplug,
} from 'lucide-react';

import type { MailAccountStatus, MailSyncState } from '../../../backend/mail/account';
import type { SiloStatus } from '../../../shared/types';
import { SILO_COLOR_MAP } from '../../../shared/silo-appearance';
import { cn } from '@/lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { SiloIndexBadge } from '../SiloCard';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import MailAccountSettings from './MailAccountSettings';
import ReconnectMailAccount from './ReconnectMailAccount';

const syncLabels: Record<MailSyncState, { label: string; className: string }> = {
  initialising: { label: 'Preparing mirror', className: 'bg-blue-400' },
  syncing: { label: 'Mirroring mail', className: 'bg-amber-500 animate-pulse' },
  idle: { label: 'Mirror up to date', className: 'bg-emerald-500' },
  'reauthorisation-required': { label: 'Reconnect required', className: 'bg-red-500' },
  error: { label: 'Mirror error', className: 'bg-red-500' },
  removing: { label: 'Removing', className: 'bg-amber-500 animate-pulse' },
};

interface MailAccountCardProps {
  account: MailAccountStatus;
  silo: SiloStatus;
  onChanged: () => void;
}

export default function MailAccountCard({ account, silo, onChanged }: MailAccountCardProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [working, setWorking] = useState<'sync' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sync = syncLabels[account.syncState];
  const color = SILO_COLOR_MAP[silo.config.accentColor];
  const progress = silo.reconcileProgress;
  const progressPercent =
    progress && progress.total > 0
      ? Math.min(Math.round((progress.current / progress.total) * 100), 99)
      : null;

  async function syncNow() {
    setWorking('sync');
    setError(null);
    try {
      const result = await window.lodestone?.mail.syncNow(account.accountHash);
      if (!result?.success) setError(result?.error ?? 'Could not start synchronisation.');
      onChanged();
    } catch (err) {
      setError(String(err));
    } finally {
      setWorking(null);
    }
  }

  async function remove(retry = false) {
    setWorking('remove');
    setError(null);
    try {
      const action = retry ? window.lodestone?.mail.retryRemove : window.lodestone?.mail.remove;
      const result = await action?.(account.accountHash);
      if (!result?.success) {
        setError(result?.error ?? 'Could not remove the account.');
        setRemoveOpen(false);
      } else {
        setRemoveOpen(false);
      }
      onChanged();
    } catch (err) {
      setError(String(err));
      setRemoveOpen(false);
      onChanged();
    } finally {
      setWorking(null);
    }
  }

  return (
    <>
      <article
        className={cn(
          'flex flex-col gap-3 rounded-lg border border-border border-l-[3px] bg-card p-4',
          color.cardAccent,
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 truncate text-sm font-semibold">
              <Mail className={cn('h-4 w-4 shrink-0', color.text)} />
              {account.displayName}
            </h3>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{account.username}</p>
          </div>
          <Badge variant="secondary">
            {account.credentialKind === 'oauth' ? 'OAuth' : 'Password'}
          </Badge>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <Badge
            variant={
              account.syncState === 'error' || account.syncState === 'reauthorisation-required'
                ? 'destructive'
                : 'secondary'
            }
            className="gap-1.5"
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', sync.className)} />
            {sync.label}
          </Badge>
          <SiloIndexBadge silo={silo} />
          {!silo.available && <Badge variant="destructive">Search unavailable</Badge>}
        </div>

        {silo.watcherState === 'indexing' && progress && progress.total > 0 && (
          <div className="space-y-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-amber-500"
                style={{ width: `${progressPercent ?? 0}%` }}
              />
            </div>
            <p className="text-[10px] text-muted-foreground">
              {progress.current.toLocaleString()} / {progress.total.toLocaleString()} files indexed
            </p>
          </div>
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <div>
            <dt className="text-muted-foreground">Folders</dt>
            <dd className="mt-0.5">{account.selectionSummary}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Messages</dt>
            <dd className="mt-0.5">{account.messageCount.toLocaleString()}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-muted-foreground">Last mirror round</dt>
            <dd className="mt-0.5">{relativeTime(account.lastRoundCompletedAt)}</dd>
          </div>
        </dl>

        {(account.lastError || error) && (
          <p className="flex items-start gap-1.5 text-xs text-red-400">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            {account.removalFailedStep
              ? `Removal failed while ${removalStepLabel(account.removalFailedStep)}.`
              : (error ?? `Mail synchronisation failed (${account.lastError}).`)}
          </p>
        )}

        <div className="mt-auto flex flex-wrap gap-1.5 border-t border-border pt-3">
          <Button
            variant="outline"
            size="sm"
            onClick={syncNow}
            disabled={working !== null || account.syncState === 'removing'}
          >
            {working === 'sync' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Sync now
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSettingsOpen(true)}
            disabled={account.syncState === 'removing'}
          >
            <Settings className="h-3.5 w-3.5" /> Settings
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReconnectOpen(true)}
            disabled={account.syncState === 'removing'}
          >
            <Unplug className="h-3.5 w-3.5" /> Reconnect
          </Button>
          {account.removalFailedStep ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void remove(true)}
              disabled={working !== null}
            >
              {working === 'remove' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Retry remove
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="text-red-400"
              onClick={() => setRemoveOpen(true)}
              disabled={working !== null}
            >
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </Button>
          )}
        </div>
      </article>

      <MailAccountSettings
        account={account}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSaved={onChanged}
      />
      <ReconnectMailAccount
        account={account}
        open={reconnectOpen}
        onOpenChange={setReconnectOpen}
        onReconnected={onChanged}
      />
      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {account.displayName}?</DialogTitle>
            <DialogDescription>
              This removes Lodestone's local mirror. It does not delete or change mail on the
              server.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-3 text-sm text-muted-foreground">
            <p>The following local data will be deleted:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Mirrored message files</li>
              <li>The mail manifest and search index</li>
              <li>The encrypted credential and account configuration</li>
            </ul>
            {account.credentialKind === 'oauth' && (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                onClick={() =>
                  window.electronAPI?.openExternal('https://myaccount.microsoft.com/permissions')
                }
              >
                Review Microsoft account permissions <ExternalLink className="h-3 w-3" />
              </button>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRemoveOpen(false)}
              disabled={working !== null}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void remove()}
              disabled={working !== null}
            >
              {working === 'remove' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Remove local mirror
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function relativeTime(value: string | null): string {
  if (!value) return 'Not completed yet';
  const elapsedSeconds = Math.round((new Date(value).getTime() - Date.now()) / 1_000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  const [unit, seconds] = units.find(([, threshold]) => Math.abs(elapsedSeconds) >= threshold) ?? [
    'second',
    1,
  ];
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
    Math.round(elapsedSeconds / seconds),
    unit,
  );
}

function removalStepLabel(step: string): string {
  return step.replaceAll('-', ' ');
}
