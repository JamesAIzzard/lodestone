import { FileText, Blocks, FolderOpen, Pause, Play, AlertTriangle, Database } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from './ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { SILO_COLOR_MAP } from '../../shared/silo-appearance';
import SiloIcon from './SiloIconComponent';
import type { SiloStatus, WatcherState } from '../../shared/types';

function abbreviatePath(p: string): string {
  return p
    .replace(/^[A-Z]:\\Users\\[^\\]+/, '~')
    .replace(/^\/home\/[^/]+/, '~');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const stateConfig: Record<WatcherState, { label: string; dotClass: string; badgeVariant: 'secondary' | 'default' | 'destructive' }> = {
  ready:    { label: 'Ready',    dotClass: 'bg-emerald-500',             badgeVariant: 'secondary' },
  scanning: { label: 'Scanning', dotClass: 'bg-amber-500 animate-pulse', badgeVariant: 'default' },
  indexing: { label: 'Indexing', dotClass: 'bg-amber-500 animate-pulse', badgeVariant: 'default' },
  error:    { label: 'Error',    dotClass: 'bg-red-500',                 badgeVariant: 'destructive' },
  stopped:  { label: 'Stopped',  dotClass: 'bg-blue-400',                badgeVariant: 'secondary' },
  waiting:  { label: 'Waiting',  dotClass: 'bg-gray-400 animate-pulse',  badgeVariant: 'secondary' },
};

interface SiloCardProps {
  silo: SiloStatus;
  onClick: () => void;
  onStopToggle?: () => void;
}

export default function SiloCard({ silo, onClick, onStopToggle }: SiloCardProps) {
  const { config, indexedFileCount, chunkCount, watcherState, reconcileProgress } = silo;
  const state = stateConfig[watcherState];
  const colorClasses = SILO_COLOR_MAP[config.color];
  const hasModelOverride = config.modelOverride !== null;
  const isStopped = watcherState === 'stopped';
  const isWaiting = watcherState === 'waiting';
  const isActive = watcherState === 'indexing' || watcherState === 'scanning';
  const progressPct = reconcileProgress && reconcileProgress.total > 0
    ? Math.round((reconcileProgress.current / reconcileProgress.total) * 100)
    : null;

  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full flex-col gap-3 rounded-lg border border-border border-l-[3px] bg-card p-4 text-left transition-colors',
        colorClasses.cardAccent,
        'hover:border-foreground/20 hover:bg-accent/30',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {/* Header: name + status */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground truncate">
            <SiloIcon icon={config.icon} className={cn('h-3.5 w-3.5 shrink-0', colorClasses.text)} />
            {config.name}
          </h3>
          {config.description && (
            <p className="text-xs text-muted-foreground/70 truncate mt-0.5">{config.description}</p>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Stop/wake button — shown in all states except waiting */}
          {onStopToggle && !isWaiting && (
            <span
              role="button"
              tabIndex={0}
              title={isStopped ? 'Wake silo' : 'Stop silo'}
              onClick={(e) => { e.stopPropagation(); onStopToggle(); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onStopToggle(); } }}
              className="rounded p-0.5 text-muted-foreground/50 transition-colors hover:text-foreground hover:bg-accent/40"
            >
              {isStopped
                ? <Play className="h-3.5 w-3.5" />
                : <Pause className="h-3.5 w-3.5" />
              }
            </span>
          )}
          <Badge variant={state.badgeVariant} className="gap-1.5 whitespace-nowrap">
            <span className={cn('inline-block h-1.5 w-1.5 rounded-full', state.dotClass)} />
            {isActive && progressPct !== null
              ? `Indexing ${progressPct}%`
              : state.label}
          </Badge>
        </div>
      </div>

      <div className={cn((isStopped || isWaiting) && 'opacity-50')}>
        {/* Progress bar (shown while scanning or indexing) */}
        {isActive && reconcileProgress && reconcileProgress.total > 0 && (
          <div className="flex flex-col gap-1">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-amber-500 transition-[width] duration-300"
                style={{ width: `${progressPct ?? 0}%` }}
              />
            </div>
            <span className="text-[10px] text-muted-foreground">
              {reconcileProgress.current.toLocaleString()} / {reconcileProgress.total.toLocaleString()} files
            </span>
          </div>
        )}

        {/* Stats */}
        <div className="flex gap-4 text-xs text-muted-foreground">
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-1.5 cursor-default">
                  <Database className="h-3.5 w-3.5" />
                  {indexedFileCount.toLocaleString()} files · {chunkCount.toLocaleString()} chunks
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Files and chunks indexed into database
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <span className="text-muted-foreground/60">
            {isActive ? `~${formatBytes(silo.databaseSizeBytes)}` : formatBytes(silo.databaseSizeBytes)}
          </span>
        </div>

        {/* Model mismatch warning */}
        {silo.modelMismatch && (
          <div className="flex items-center gap-1.5 text-xs text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            Model mismatch — rebuild required
          </div>
        )}

        {/* Model (always shown) */}
        <div className={cn('text-xs', hasModelOverride ? 'text-amber-400/80' : 'text-muted-foreground/50')}>
          {silo.resolvedModel}
        </div>

        {/* Directories */}
        <div className="flex flex-col gap-1">
          {config.directories.map((dir) => (
            <span key={dir} className="flex items-center gap-1.5 text-xs text-muted-foreground/70 min-w-0">
              <FolderOpen className="h-3 w-3 shrink-0" />
              <span className="truncate">{abbreviatePath(dir)}</span>
            </span>
          ))}
        </div>
      </div>
    </button>
  );
}
