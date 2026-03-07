import { useState, useEffect, useMemo } from 'react';
import { AlertCircle, ChevronDown, Copy, FileMinus, RefreshCw, FilePlus, FolderPlus, FolderMinus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import FilterBar from '@/components/FilterBar';
import { SILO_COLOR_MAP, DEFAULT_SILO_COLOR, type SiloColor } from '../../shared/silo-appearance';
import type { SiloStatus, ActivityEvent, ActivityEventType } from '../../shared/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fileName(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

function dirPath(p: string): string {
  const parts = p.split(/[/\\]/);
  parts.pop();
  return parts.join('/');
}

function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Constants ─────────────────────────────────────────────────────────────────

const eventConfig: Record<
  ActivityEventType,
  { label: string; icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  indexed: { label: 'Indexed', icon: FilePlus, className: 'text-emerald-400' },
  reindexed: { label: 'Re-indexed', icon: RefreshCw, className: 'text-blue-400' },
  deleted: { label: 'Deleted', icon: FileMinus, className: 'text-muted-foreground' },
  error: { label: 'Error', icon: AlertCircle, className: 'text-red-400' },
  'dir-added': { label: 'Dir Added', icon: FolderPlus, className: 'text-teal-400' },
  'dir-removed': { label: 'Dir Removed', icon: FolderMinus, className: 'text-muted-foreground/70' },
};

const ALL_EVENT_TYPES: ActivityEventType[] = ['indexed', 'reindexed', 'deleted', 'error', 'dir-added', 'dir-removed'];

// ── Props ─────────────────────────────────────────────────────────────────────

interface ActivityFeedProps {
  /** Pre-filter to a single silo (hides the silo badge column). */
  siloName?: string;
  /** Max events to retain in the list. Default 200. */
  limit?: number;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ActivityFeed({ siloName, limit = 200 }: ActivityFeedProps) {
  const [silos, setSilos] = useState<SiloStatus[]>([]);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [activeTypes, setActiveTypes] = useState<Set<ActivityEventType>>(
    new Set(ALL_EVENT_TYPES),
  );
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());

  // Build silo name → colour lookup
  const siloColorMap = useMemo(() => {
    const map = new Map<string, SiloColor>();
    for (const s of silos) map.set(s.config.name, s.config.color);
    return map;
  }, [silos]);

  useEffect(() => {
    window.electronAPI?.getSilos().then(setSilos);
    window.electronAPI?.getActivity(limit).then(setEvents);

    // Subscribe to live push updates
    const unsubscribe = window.electronAPI?.onActivity((event) => {
      setEvents((prev) => [event, ...prev].slice(0, limit));
    });

    return () => unsubscribe?.();
  }, [limit]);

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

  const filtered = events.filter((e) => {
    if (siloName && e.siloName !== siloName) return false;
    if (!activeTypes.has(e.eventType)) return false;
    return true;
  });

  return (
    <div>
      {/* Type filter toggles */}
      <FilterBar
        options={ALL_EVENT_TYPES.map((type) => ({ value: type, label: eventConfig[type].label }))}
        isActive={(v) => activeTypes.has(v as ActivityEventType)}
        onSelect={(v) => toggleType(v as ActivityEventType)}
        className="mb-3"
      />

      {/* Event list */}
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity events yet.</p>
      ) : (
        <div className="flex flex-col">
          {filtered.map((event) => {
            const config = eventConfig[event.eventType];
            const Icon = config.icon;
            const isError = event.eventType === 'error';
            const isExpanded = expandedErrors.has(event.id);

            return (
              <div
                key={event.id}
                onClick={() => isError && toggleError(event.id)}
                className={cn(
                  'rounded-md px-3 py-2 transition-colors',
                  isError && 'cursor-pointer hover:bg-accent/30',
                )}
              >
                <div className="flex w-full items-center gap-3">
                  <span className="w-16 shrink-0 text-xs text-muted-foreground/50 tabular-nums">
                    {formatTime(event.timestamp)}
                  </span>

                  <span className={cn('flex w-24 shrink-0 items-center gap-1.5 text-xs', config.className)}>
                    <Icon className="h-3.5 w-3.5" />
                    {config.label}
                  </span>

                  {/* Silo badge — hidden when pre-filtered to a single silo */}
                  {!siloName && (
                    <Badge
                      variant="secondary"
                      className={cn(
                        'shrink-0 text-[10px]',
                        (() => {
                          const c = siloColorMap.get(event.siloName) ?? DEFAULT_SILO_COLOR;
                          const classes = SILO_COLOR_MAP[c];
                          return `${classes.bgSoft} ${classes.text} border-0`;
                        })(),
                      )}
                    >
                      {event.siloName}
                    </Badge>
                  )}

                  <div className="flex-1 min-w-0 truncate">
                    <span className="text-xs text-foreground">
                      {fileName(event.filePath)}
                    </span>
                    <span className="ml-2 text-xs text-muted-foreground/40 hidden sm:inline">
                      {dirPath(event.filePath)}
                    </span>
                  </div>

                  {isError && (
                    <ChevronDown
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                        isExpanded && 'rotate-180',
                      )}
                    />
                  )}
                </div>

                {isError && isExpanded && event.errorMessage && (
                  <div className="mt-1 flex items-start gap-2 pl-[calc(4rem+6rem+1.5rem)]">
                    <p className="flex-1 min-w-0 text-xs text-red-400">{event.errorMessage}</p>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigator.clipboard.writeText(event.errorMessage!);
                      }}
                      className="shrink-0 rounded p-0.5 text-red-400/50 hover:text-red-400 transition-colors"
                      title="Copy error message"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
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
