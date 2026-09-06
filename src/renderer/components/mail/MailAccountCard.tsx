import { useState } from 'react';
import { AlertTriangle, Loader2, Mail, Pause, Play, RefreshCw, Search } from 'lucide-react';

import type { MailAccountStatus } from '../../../backend/mail/account';
import type { SiloStatus } from '../../../shared/types';
import { SILO_COLOR_MAP } from '../../../shared/silo-appearance';
import { cn } from '@/lib/utils';
import { Badge } from '../ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

interface MailAccountCardProps {
  account: MailAccountStatus;
  silo: SiloStatus;
  onClick: () => void;
  onChanged: () => void;
  onSearchInSilo: () => void;
  onStopToggle: () => void;
  isStopping?: boolean;
  shimmerKey?: number;
}

export default function MailAccountCard({
  account,
  silo,
  onClick,
  onChanged,
  onSearchInSilo,
  onStopToggle,
  isStopping,
  shimmerKey,
}: MailAccountCardProps) {
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const color = SILO_COLOR_MAP[silo.config.accentColor];
  const stopped = silo.watcherState === 'stopped' || account.syncState === 'paused';
  const mirrorProgress = account.mirrorProgress;
  const state = combinedState(account, silo);

  async function syncNow() {
    setSyncing(true);
    setError(null);
    try {
      const result = await window.lodestone?.mail.syncNow(account.accountHash);
      if (!result?.success) setError(result?.error ?? 'Could not start synchronisation.');
      onChanged();
    } catch (err) {
      setError(String(err));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative flex w-full flex-col gap-3 overflow-hidden rounded-lg border border-border border-l-[3px] bg-card p-4 text-left transition-colors',
        color.cardAccent,
        'hover:border-foreground/20 hover:bg-accent/30',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Badge variant={state.variant} className="gap-1.5 whitespace-nowrap">
              <span className={cn('h-1.5 w-1.5 rounded-full', state.dotClass)} />
              {state.label}
            </Badge>
            <Badge variant="secondary">Read-only</Badge>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <CardAction label="Search in this silo" onClick={onSearchInSilo}>
              <Search className="h-3.5 w-3.5" />
            </CardAction>
            <CardAction
              label={stopped ? 'Source is paused' : 'Synchronise mail now'}
              onClick={() => void syncNow()}
              disabled={stopped || syncing || account.syncState === 'removing'}
            >
              {syncing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </CardAction>
            <CardAction
              label={isStopping ? 'Pausing source' : stopped ? 'Resume source' : 'Pause source'}
              onClick={onStopToggle}
              disabled={isStopping}
            >
              {isStopping ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : stopped ? (
                <Play className="h-3.5 w-3.5" />
              ) : (
                <Pause className="h-3.5 w-3.5" />
              )}
            </CardAction>
          </div>
        </div>
        <h3 className="flex items-center gap-1.5 truncate text-sm font-semibold text-foreground">
          <Mail className={cn('h-3.5 w-3.5 shrink-0', color.text)} />
          {silo.config.name}
        </h3>
        <p className="truncate text-xs text-muted-foreground/70">{account.username}</p>
      </div>

      <div className={cn('space-y-3', stopped && 'opacity-50')}>
        <Progress
          label={
            account.syncState === 'syncing'
              ? mirrorProgress?.phase === 'finalising'
                ? 'Finalising mirror'
                : `Mirroring${mirrorProgress?.folder ? ` ${mirrorProgress.folder}` : ''}`
              : stopped
                ? 'Mirror paused'
                : 'Mirror up to date'
          }
          current={mirrorProgress?.current ?? account.messageCount}
          total={
            mirrorProgress?.total ?? (account.lastRoundCompletedAt ? account.messageCount : null)
          }
          colour="bg-violet-500"
          complete={
            account.syncState === 'idle' || (stopped && account.lastRoundCompletedAt !== null)
          }
        />
        <Progress
          label={
            silo.watcherState === 'indexing'
              ? 'Indexing messages'
              : stopped
                ? 'Index paused'
                : 'Index up to date'
          }
          current={silo.indexedFileCount}
          total={Math.max(account.messageCount, silo.indexedFileCount)}
          colour="bg-amber-500"
          complete={silo.indexCaughtUp}
        />

        <div className="space-y-1 text-xs text-muted-foreground">
          <div className="flex items-center justify-between gap-3">
            <span>{account.messageCount.toLocaleString()} items mirrored</span>
            <span>{silo.indexedFileCount.toLocaleString()} indexed</span>
          </div>
          <p className="truncate">{account.selectionSummary}</p>
          <p>Last mirror round: {relativeTime(account.lastRoundCompletedAt)}</p>
        </div>
      </div>

      {(account.lastError || error) && (
        <p className="flex items-start gap-1.5 text-xs text-red-400">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          {error ?? `Mail synchronisation failed (${account.lastError}).`}
        </p>
      )}

      {(shimmerKey ?? 0) > 0 && (
        <div
          key={shimmerKey}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 animate-neural-shimmer"
          style={{
            background: `linear-gradient(108deg, transparent 38%, rgba(${color.shimmerRgb},0.08) 45%, rgba(${color.shimmerRgb},0.18) 50%, rgba(${color.shimmerRgb},0.08) 55%, transparent 62%)`,
          }}
        />
      )}
    </button>
  );
}

function CardAction({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="button"
            tabIndex={disabled ? -1 : 0}
            onClick={(event) => {
              event.stopPropagation();
              if (!disabled) onClick();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.stopPropagation();
                if (!disabled) onClick();
              }
            }}
            className={cn(
              'rounded p-0.5 transition-colors',
              disabled
                ? 'cursor-default text-muted-foreground/25'
                : 'text-muted-foreground/50 hover:bg-accent/40 hover:text-foreground',
            )}
          >
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function Progress({
  label,
  current,
  total,
  colour,
  complete = false,
}: {
  label: string;
  current: number;
  total: number | null;
  colour: string;
  complete?: boolean;
}) {
  const percent = complete
    ? 100
    : total && total > 0
      ? Math.min(Math.round((current / total) * 100), 99)
      : null;
  return (
    <div className="space-y-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'relative h-full overflow-hidden rounded-full transition-[width] duration-300',
            colour,
            percent === null && 'w-1/3 animate-pulse',
          )}
          style={percent === null ? undefined : { width: `${percent}%` }}
        >
          {complete && (
            <span className="absolute inset-y-0 left-0 w-1/3 animate-progress-shimmer bg-gradient-to-r from-transparent via-white/25 to-transparent" />
          )}
        </div>
      </div>
      <div className="flex justify-between gap-2 text-[10px] text-muted-foreground">
        <span className="truncate">{label}</span>
        <span className="shrink-0">
          {current.toLocaleString()}
          {total !== null ? ` / ${total.toLocaleString()}` : ''}
        </span>
      </div>
    </div>
  );
}

function combinedState(account: MailAccountStatus, silo: SiloStatus) {
  if (silo.watcherState === 'stopped' || account.syncState === 'paused')
    return { label: 'Paused', dotClass: 'bg-blue-400', variant: 'secondary' as const };
  if (account.syncState === 'error' || account.syncState === 'reauthorisation-required')
    return { label: 'Error', dotClass: 'bg-red-500', variant: 'destructive' as const };
  if (account.syncState === 'syncing')
    return {
      label: 'Mirroring',
      dotClass: 'bg-violet-500 animate-pulse',
      variant: 'default' as const,
    };
  if (silo.watcherState === 'indexing')
    return {
      label: 'Indexing',
      dotClass: 'bg-amber-500 animate-pulse',
      variant: 'default' as const,
    };
  return { label: 'Ready', dotClass: 'bg-emerald-500', variant: 'secondary' as const };
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
