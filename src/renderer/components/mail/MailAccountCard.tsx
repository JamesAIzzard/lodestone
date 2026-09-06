import { useCallback, useState } from 'react';
import {
  AlertTriangle,
  Copy,
  Database,
  Loader2,
  Mail,
  Pause,
  Play,
  RefreshCw,
  Search,
} from 'lucide-react';

import type { MailAccountStatus } from '../../../backend/mail/account';
import type { SiloStatus } from '../../../shared/types';
import { SILO_COLOR_MAP } from '../../../shared/silo-appearance';
import { formatBytes } from '@/lib/format';
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
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const color = SILO_COLOR_MAP[silo.config.accentColor];
  const stopped = silo.watcherState === 'stopped' || account.syncState === 'paused';
  const mirrorProgress = account.mirrorProgress;
  const state = combinedState(account, silo);
  const copyDatabasePath = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      navigator.clipboard.writeText(silo.resolvedDbPath).catch((): void => undefined);
      setCopiedPath(silo.resolvedDbPath);
      setTimeout(() => setCopiedPath(null), 2_000);
    },
    [silo.resolvedDbPath],
  );

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
        {silo.config.contentDescription && (
          <p className="truncate text-xs text-muted-foreground/70">
            {silo.config.contentDescription}
          </p>
        )}
      </div>

      <div className={cn('space-y-3', stopped && 'opacity-50')}>
        <DualProgress
          mirrorLabel={
            account.syncState === 'syncing'
              ? mirrorProgress?.phase === 'finalising'
                ? 'Finalising mirror'
                : `Mirroring${mirrorProgress?.folder ? ` ${mirrorProgress.folder}` : ''}`
              : stopped
                ? 'Mirror paused'
                : 'Mirror up to date'
          }
          mirrorCurrent={mirrorProgress?.current ?? account.messageCount}
          mirrorTotal={
            mirrorProgress?.total ?? (account.lastRoundCompletedAt ? account.messageCount : null)
          }
          mirrorComplete={
            account.syncState === 'idle' || (stopped && account.lastRoundCompletedAt !== null)
          }
          indexLabel={
            silo.watcherState === 'indexing'
              ? 'Indexing messages'
              : stopped
                ? 'Index paused'
                : 'Index up to date'
          }
          indexCurrent={silo.indexedFileCount}
          indexTotal={Math.max(account.messageCount, silo.indexedFileCount)}
          indexComplete={silo.indexCaughtUp}
        />

        <div className="flex flex-col">
          <div className="flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground">
            <Database className="mt-px h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0">
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="group flex min-w-0 cursor-pointer items-center gap-1 transition-colors hover:text-foreground/80"
                      onClick={copyDatabasePath}
                    >
                      <span className="flex-1 truncate">{silo.resolvedDbPath}</span>
                      <Copy className="h-2.5 w-2.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-50" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {copiedPath === silo.resolvedDbPath ? '✓ Copied!' : 'Click to copy path'}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <span className="mt-0.5 block text-muted-foreground/60">
                {silo.indexedFileCount.toLocaleString()} messages ·{' '}
                {silo.chunkCount.toLocaleString()} chunks · {formatBytes(silo.databaseSizeBytes)}
              </span>
            </div>
          </div>

          <div className="ml-[6.5px] my-1.5 h-3 w-px bg-border" />

          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/70">
            <Mail className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 truncate">{account.username}</span>
          </div>
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

function DualProgress({
  mirrorLabel,
  mirrorCurrent,
  mirrorTotal,
  mirrorComplete,
  indexLabel,
  indexCurrent,
  indexTotal,
  indexComplete,
}: {
  mirrorLabel: string;
  mirrorCurrent: number;
  mirrorTotal: number | null;
  mirrorComplete: boolean;
  indexLabel: string;
  indexCurrent: number;
  indexTotal: number;
  indexComplete: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="space-y-0.5">
        <ProgressTrack
          current={mirrorCurrent}
          total={mirrorTotal}
          colour="bg-violet-500"
          complete={mirrorComplete}
        />
        <ProgressTrack
          current={indexCurrent}
          total={indexTotal}
          colour="bg-amber-500"
          complete={indexComplete}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 text-[10px] text-muted-foreground">
        <ProgressLegend
          label={mirrorLabel}
          current={mirrorCurrent}
          total={mirrorTotal}
          dotClass="bg-violet-500"
        />
        <ProgressLegend
          label={indexLabel}
          current={indexCurrent}
          total={indexTotal}
          dotClass="bg-amber-500"
          align="right"
        />
      </div>
    </div>
  );
}

function ProgressTrack({
  current,
  total,
  colour,
  complete,
}: {
  current: number;
  total: number | null;
  colour: string;
  complete: boolean;
}) {
  const percent = complete
    ? 100
    : total && total > 0
      ? Math.min(Math.round((current / total) * 100), 99)
      : null;
  return (
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
  );
}

function ProgressLegend({
  label,
  current,
  total,
  dotClass,
  align = 'left',
}: {
  label: string;
  current: number;
  total: number | null;
  dotClass: string;
  align?: 'left' | 'right';
}) {
  return (
    <div className={cn('flex min-w-0 items-center gap-1', align === 'right' && 'justify-end')}>
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotClass)} />
      <span className="truncate" title={label}>
        {label}
      </span>
      <span className="shrink-0 text-muted-foreground/70">
        {current.toLocaleString()}
        {total !== null ? `/${total.toLocaleString()}` : ''}
      </span>
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
