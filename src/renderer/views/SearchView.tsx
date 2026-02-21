import { useState, useEffect } from 'react';
import { Search, FileText, ExternalLink, Loader2, ChevronRight, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SiloStatus, SearchResult, MatchType } from '../../shared/types';

function fileName(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

function dirPath(p: string): string {
  const parts = p.split(/[/\\]/);
  parts.pop();
  return parts.join('/');
}

function scorePercent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function handleOpenFile(filePath: string) {
  window.electronAPI?.openPath(filePath);
}

const matchTypeLabel: Record<MatchType, string> = {
  semantic: 'semantic',
  keyword: 'keyword',
  both: 'semantic + keyword',
};

const matchTypeColor: Record<MatchType, string> = {
  semantic: 'bg-blue-500/15 text-blue-400',
  keyword: 'bg-amber-500/15 text-amber-400',
  both: 'bg-emerald-500/15 text-emerald-400',
};

export default function SearchView() {
  const [query, setQuery] = useState('');
  const [selectedSilo, setSelectedSilo] = useState('all');
  const [silos, setSilos] = useState<SiloStatus[]>([]);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [expandedResults, setExpandedResults] = useState<Set<number>>(new Set());

  useEffect(() => {
    window.electronAPI?.getSilos().then(setSilos);
  }, []);

  async function handleSearch() {
    if (!query.trim() || searching) return;
    setHasSearched(true);
    setSearching(true);
    setExpandedResults(new Set());
    try {
      const silo = selectedSilo === 'all' ? undefined : selectedSilo;
      const res = await window.electronAPI?.search(query, silo) ?? [];
      setResults(res);
    } finally {
      setSearching(false);
    }
  }

  function toggleExpand(index: number) {
    setExpandedResults((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  return (
    <div className="p-6">
      <h1 className="mb-6 text-lg font-semibold text-foreground">Search</h1>

      {/* Controls */}
      <div className="flex gap-3">
        <select
          value={selectedSilo}
          onChange={(e) => setSelectedSilo(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All Silos</option>
          {silos.map((s) => (
            <option key={s.config.name} value={s.config.name} disabled={s.watcherState === 'sleeping'}>
              {s.config.name}{s.watcherState === 'sleeping' ? ' (sleeping)' : ''}
            </option>
          ))}
        </select>

        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Search your indexed files..."
            className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      {/* Results */}
      <div className="mt-6">
        {searching && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Searching...
          </div>
        )}

        {!searching && !hasSearched && (
          <p className="text-sm text-muted-foreground">
            Enter a query and press Enter to search.
          </p>
        )}

        {!searching && hasSearched && (() => {
          const sleepingSilos = silos.filter((s) => s.watcherState === 'sleeping');
          const sleepingSkipped = selectedSilo === 'all'
            ? sleepingSilos
            : sleepingSilos.filter((s) => s.config.name === selectedSilo);
          const sleepingHint = sleepingSkipped.length > 0
            ? `${sleepingSkipped.map((s) => s.config.name).join(', ')} ${sleepingSkipped.length === 1 ? 'is' : 'are'} sleeping and ${sleepingSkipped.length === 1 ? 'was' : 'were'} not searched.`
            : null;

          return results.length === 0 ? (
            <div>
              <p className="text-sm text-muted-foreground">No results found.</p>
              {sleepingHint && (
                <p className="mt-1 text-xs text-muted-foreground/50">{sleepingHint}</p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <div className="mb-3">
                <p className="text-xs text-muted-foreground">
                  {results.length} result{results.length !== 1 && 's'}
                </p>
                {sleepingHint && (
                  <p className="mt-0.5 text-[10px] text-muted-foreground/50">{sleepingHint}</p>
                )}
              </div>

            {results.map((result, i) => {
              const isExpanded = expandedResults.has(i);

              return (
                <div key={`${result.filePath}-${i}`}>
                  {/* Result row */}
                  <button
                    onClick={() => toggleExpand(i)}
                    className={cn(
                      'group flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors',
                      'hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      isExpanded && 'bg-accent/20',
                    )}
                  >
                    {isExpanded
                      ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    }

                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {fileName(result.filePath)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground/50">
                        <span className="truncate">{dirPath(result.filePath)}</span>
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {result.siloName}
                        </span>
                        <span className={cn(
                          'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
                          matchTypeColor[result.matchType],
                        )}>
                          {matchTypeLabel[result.matchType]}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-foreground/30"
                          style={{ width: scorePercent(result.score) }}
                        />
                      </div>
                      <span className="w-8 text-right text-xs text-muted-foreground">
                        {scorePercent(result.score)}
                      </span>
                    </div>

                    <ExternalLink
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground/30 opacity-0 transition-opacity group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleOpenFile(result.filePath);
                      }}
                    />
                  </button>

                  {/* Expanded chunks */}
                  {isExpanded && result.chunks.length > 0 && (
                    <div className="ml-[26px] border-l-2 border-accent/40 pl-4 pb-2">
                      {result.chunks.map((chunk, ci) => (
                        <div
                          key={ci}
                          className="mt-2 rounded-md bg-muted/30 px-3 py-2"
                        >
                          <div className="flex items-center justify-between gap-2 mb-1">
                            {chunk.sectionPath.length > 0 && (
                              <span className="text-[11px] font-medium text-muted-foreground">
                                {chunk.sectionPath.join(' > ')}
                              </span>
                            )}
                            <span className="shrink-0 text-[10px] text-muted-foreground/50">
                              {scorePercent(chunk.score)}
                            </span>
                          </div>
                          <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground/70">
                            {chunk.text}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          );
        })()}
      </div>
    </div>
  );
}
