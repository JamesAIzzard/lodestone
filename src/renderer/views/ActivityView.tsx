import { useState } from 'react';
import { AlertCircle, ChevronDown, FileMinus, RefreshCw, FilePlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { mockSilos, mockActivityEvents } from '../../shared/mock-data';
import type { ActivityEventType } from '../../shared/types';

function fileName(path: string): string {
  return path.split('/').pop() ?? path;
}

function dirPath(path: string): string {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/').replace(/^\/home\/[^/]+/, '~');
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const eventConfig: Record<
  ActivityEventType,
  { label: string; icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  indexed: { label: 'Indexed', icon: FilePlus, className: 'text-emerald-400' },
  reindexed: { label: 'Re-indexed', icon: RefreshCw, className: 'text-blue-400' },
  deleted: { label: 'Deleted', icon: FileMinus, className: 'text-muted-foreground' },
  error: { label: 'Error', icon: AlertCircle, className: 'text-red-400' },
};

const ALL_EVENT_TYPES: ActivityEventType[] = ['indexed', 'reindexed', 'deleted', 'error'];

export default function ActivityView() {
  const [siloFilter, setSiloFilter] = useState('all');
  const [activeTypes, setActiveTypes] = useState<Set<ActivityEventType>>(
    new Set(ALL_EVENT_TYPES),
  );
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());

  function toggleType(type: ActivityEventType) {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        if (next.size > 1) next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }

  function toggleError(id: string) {
    setExpandedErrors((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const filtered = mockActivityEvents.filter((e) => {
    if (siloFilter !== 'all' && e.siloName !== siloFilter) return false;
    if (!activeTypes.has(e.eventType)) return false;
    return true;
  });

  return (
    <div className="p-6">
      <h1 className="mb-6 text-lg font-semibold text-foreground">Activity</h1>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={siloFilter}
          onChange={(e) => setSiloFilter(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-3 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All Silos</option>
          {mockSilos.map((s) => (
            <option key={s.config.name} value={s.config.name}>
              {s.config.name}
            </option>
          ))}
        </select>

        <div className="flex gap-1">
          {ALL_EVENT_TYPES.map((type) => {
            const config = eventConfig[type];
            const active = activeTypes.has(type);
            return (
              <button
                key={type}
                onClick={() => toggleType(type)}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-xs transition-colors',
                  active
                    ? 'border-foreground/20 bg-accent text-foreground'
                    : 'border-border text-muted-foreground/40 hover:text-muted-foreground',
                )}
              >
                {config.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Feed */}
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No matching events.</p>
      ) : (
        <div className="flex flex-col">
          {filtered.map((event) => {
            const config = eventConfig[event.eventType];
            const Icon = config.icon;
            const isError = event.eventType === 'error';
            const isExpanded = expandedErrors.has(event.id);

            return (
              <div key={event.id}>
                <button
                  onClick={() => isError && toggleError(event.id)}
                  disabled={!isError}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors',
                    isError && 'cursor-pointer hover:bg-accent/30',
                    !isError && 'cursor-default',
                  )}
                >
                  {/* Time */}
                  <span className="w-16 shrink-0 text-xs text-muted-foreground/50 tabular-nums">
                    {formatTime(event.timestamp)}
                  </span>

                  {/* Icon + type */}
                  <span className={cn('flex w-24 shrink-0 items-center gap-1.5 text-xs', config.className)}>
                    <Icon className="h-3.5 w-3.5" />
                    {config.label}
                  </span>

                  {/* Silo */}
                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                    {event.siloName}
                  </Badge>

                  {/* File */}
                  <div className="flex-1 min-w-0">
                    <span className="truncate text-xs text-foreground">
                      {fileName(event.filePath)}
                    </span>
                    <span className="ml-2 text-xs text-muted-foreground/40 hidden sm:inline">
                      {dirPath(event.filePath)}
                    </span>
                  </div>

                  {/* Error expand indicator */}
                  {isError && (
                    <ChevronDown
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                        isExpanded && 'rotate-180',
                      )}
                    />
                  )}
                </button>

                {/* Error detail */}
                {isError && isExpanded && event.errorMessage && (
                  <div className="mx-3 mb-2 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-400">
                    {event.errorMessage}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
