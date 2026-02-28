import { useState, useCallback } from 'react';
import { FolderOpen, Loader2, Pause, Play, AlertTriangle, Database, Copy, RefreshCw, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from './ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { SILO_COLOR_MAP } from '../../shared/silo-appearance';
import SiloIcon from './SiloIconComponent';
import type { SiloStatus, WatcherState } from '../../shared/types';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const stageLabels: Record<string, string> = {
  reading: 'Reading',
  extracting: 'Extracting',
  chunking: 'Chunking',
  embedding: 'Embedding',
  flushing: 'Saving',
};

const stateConfig: Record<WatcherState, { label: string; dotClass: string; badgeVariant: 'secondary' | 'default' | 'destructive' }> = {
  ready:    { label: 'Ready',    dotClass: 'bg-emerald-500',             badgeVariant: 'secondary' },
  indexing: { label: 'Indexing', dotClass: 'bg-amber-500 animate-pulse', badgeVariant: 'default' },
  error:    { label: 'Error',    dotClass: 'bg-red-500',                 badgeVariant: 'destructive' },
  stopped:  { label: 'Stopped',  dotClass: 'bg-blue-400',                badgeVariant: 'secondary' },
  waiting:  { label: 'Waiting',  dotClass: 'bg-gray-400 animate-pulse',  badgeVariant: 'secondary' },
};

interface SiloCardProps {
  silo: SiloStatus;
  onClick: () => void;
  onStopToggle?: () => void;
  isStopping?: boolean;
  onRescan?: () => void;
  onSearchInSilo?: () => void;
  shimmerKey?: number;
}

export default function SiloCard({ silo, onClick, onStopToggle, isStopping, onRescan, onSearchInSilo, shimmerKey }: SiloCardProps) {
  const { config, indexedFileCount, chunkCount, watcherState, reconcileProgress } = silo;
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const copyPath = useCallback((e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    navigator.clipboard.writeText(path).catch(() => {});
    setCopiedPath(path);
    setTimeout(() => setCopiedPath(null), 2000);
  }, []);
  const state = stateConfig[watcherState];
  const colorClasses = SILO_COLOR_MAP[config.color];
  const hasModelOverride = config.modelOverride !== null;
  const isStopped = watcherState === 'stopped';
  const isWaiting = watcherState === 'waiting';
  const isActive = watcherState === 'indexing';
  const progressPct = reconcileProgress && reconcileProgress.total > 0
    ? Math.round((reconcileProgress.current / reconcileProgress.total) * 100)
    : null;

  return (
    <button
      onClick={onClick}
      className={cn(
        'relative overflow-hidden flex w-full flex-col gap-3 rounded-lg border border-border border-l-[3px] bg-card p-4 text-left transition-colors',
        colorClasses.cardAccent,
        'hover:border-foreground/20 hover:bg-accent/30',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {/* Header: status + actions row, then name + description below */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <Badge variant={state.badgeVariant} className="gap-1.5 whitespace-nowrap">
            <span className={cn('inline-block h-1.5 w-1.5 rounded-full', state.dotClass)} />
            {isActive && progressPct !== null
              ? `Indexing ${progressPct}%`
              : state.label}
          </Badge>
          <div className="flex items-center gap-1.5 shrink-0">
          {/* Search in silo */}
          {onSearchInSilo && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); onSearchInSilo(); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onSearchInSilo(); } }}
                    className="rounded p-0.5 text-muted-foreground/50 transition-colors hover:text-foreground hover:bg-accent/40"
                  >
                    <Search className="h-3.5 w-3.5" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">Search in this silo</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* Rescan */}
          {onRescan && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="button"
                    tabIndex={isActive || isWaiting || isStopped ? -1 : 0}
                    onClick={(e) => { e.stopPropagation(); if (!isActive && !isWaiting && !isStopped) onRescan(); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); if (!isActive && !isWaiting && !isStopped) onRescan(); } }}
                    className={cn(
                      'rounded p-0.5 transition-colors',
                      isActive || isWaiting || isStopped
                        ? 'text-muted-foreground/25 cursor-default'
                        : 'text-muted-foreground/50 hover:text-foreground hover:bg-accent/40',
                    )}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {isStopped ? 'Silo is stopped' : isActive ? 'Already indexing' : isWaiting ? 'Waiting to index' : 'Rescan for changes'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* Stop/wake button — shown in all states except waiting */}
          {onStopToggle && !isWaiting && (
            <span
              role="button"
              tabIndex={0}
              title={isStopping ? 'Stopping…' : isStopped ? 'Wake silo' : 'Stop silo'}
              onClick={(e) => { e.stopPropagation(); if (!isStopping) onStopToggle(); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); if (!isStopping) onStopToggle(); } }}
              className={cn(
                'rounded p-0.5 transition-colors',
                isStopping
                  ? 'text-muted-foreground/50'
                  : 'text-muted-foreground/50 hover:text-foreground hover:bg-accent/40',
              )}
            >
              {isStopping
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : isStopped
                  ? <Play className="h-3.5 w-3.5" />
                  : <Pause className="h-3.5 w-3.5" />
              }
            </span>
          )}
          </div>
        </div>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground truncate">
          <SiloIcon icon={config.icon} className={cn('h-3.5 w-3.5 shrink-0', colorClasses.text)} />
          {config.name}
        </h3>
        {config.description && (
          <p className="text-xs text-muted-foreground/70 truncate">{config.description}</p>
        )}
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
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span>
                {reconcileProgress.current.toLocaleString()} / {reconcileProgress.total.toLocaleString()} files
              </span>
              {reconcileProgress.batchChunks != null && reconcileProgress.batchChunkLimit != null && (
                <span className="text-muted-foreground/60">
                  batch: {reconcileProgress.batchChunks} / {reconcileProgress.batchChunkLimit} chunks
                </span>
              )}
            </div>
            {/* Stage label + current filename */}
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
              {reconcileProgress.fileStage && stageLabels[reconcileProgress.fileStage] && (
                <span className="shrink-0 text-muted-foreground/80 font-medium">
                  {stageLabels[reconcileProgress.fileStage]}
                </span>
              )}
              {reconcileProgress.filePath && (
                <span className="truncate">
                  {reconcileProgress.filePath.split(/[\\/]/).pop()}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Two linked groups: database ← directories */}
        <div className="flex flex-col">
          {/* Database group */}
          <div className="flex items-start gap-1.5 text-xs text-muted-foreground min-w-0">
            <Database className="h-3.5 w-3.5 mt-px shrink-0" />
            <div className="min-w-0">
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="group flex items-center gap-1 cursor-pointer hover:text-foreground/80 transition-colors min-w-0"
                      onClick={(e) => copyPath(e, silo.resolvedDbPath)}
                    >
                      <span className="truncate flex-1">{silo.resolvedDbPath}</span>
                      <Copy className="h-2.5 w-2.5 shrink-0 opacity-0 group-hover:opacity-50 transition-opacity" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {copiedPath === silo.resolvedDbPath ? '✓ Copied!' : 'Click to copy path'}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <span className="text-muted-foreground/60 block mt-0.5">
                {indexedFileCount.toLocaleString()} files · {chunkCount.toLocaleString()} chunks · {isActive ? `~${formatBytes(silo.databaseSizeBytes)}` : formatBytes(silo.databaseSizeBytes)}
              </span>
              {silo.modelMismatch && (
                <span className="flex items-center gap-1 text-amber-400 mt-0.5">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  Model mismatch — rebuild required
                </span>
              )}
              <span className={cn('block mt-0.5', hasModelOverride ? 'text-amber-400/80' : 'text-muted-foreground/50')}>
                {silo.resolvedModel}
              </span>
            </div>
          </div>

          {/* Connector */}
          <div className="ml-[6.5px] my-1.5 w-px h-3 bg-border" />

          {/* Directories group */}
          <div className="flex flex-col gap-1">
            {config.directories.map((dir) => (
              <TooltipProvider key={dir} delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="group flex items-center gap-1.5 text-xs text-muted-foreground/70 cursor-pointer hover:text-muted-foreground transition-colors min-w-0"
                      onClick={(e) => copyPath(e, dir)}
                    >
                      <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate flex-1">{dir}</span>
                      <Copy className="h-2.5 w-2.5 shrink-0 opacity-0 group-hover:opacity-50 transition-opacity" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {copiedPath === dir ? '✓ Copied!' : 'Click to copy path'}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ))}
          </div>
        </div>
      </div>

      {/* Neural shimmer — color-tinted sweep when Claude queries this silo via MCP */}
      {(shimmerKey ?? 0) > 0 && (
        <div
          key={shimmerKey}
          aria-hidden
          className="absolute inset-0 pointer-events-none animate-neural-shimmer"
          style={{
            background: `linear-gradient(108deg, transparent 38%, rgba(${colorClasses.shimmerRgb},0.08) 45%, rgba(${colorClasses.shimmerRgb},0.18) 50%, rgba(${colorClasses.shimmerRgb},0.08) 55%, transparent 62%)`,
          }}
        />
      )}
    </button>
  );
}
