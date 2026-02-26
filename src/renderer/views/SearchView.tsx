import { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, FileText, Folder, ExternalLink, Loader2, ChevronRight, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SILO_COLOR_MAP, DEFAULT_SILO_COLOR, type SiloColor } from '../../shared/silo-appearance';
import type { SiloStatus, SearchResult, DirectoryResult, DirectoryTreeNode, ExploreParams, SearchMode } from '../../shared/types';

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

// ── Signal colours ──────────────────────────────────────────────────────────

const SIGNAL_COLORS: Record<string, { bar: string; badge: string; label: string }> = {
  semantic:    { bar: 'bg-blue-400',   badge: 'bg-blue-500/15 text-blue-400',   label: 'semantic' },
  bm25:        { bar: 'bg-amber-400',  badge: 'bg-amber-500/15 text-amber-400', label: 'bm25' },
  filepath:    { bar: 'bg-cyan-400',   badge: 'bg-cyan-500/15 text-cyan-400',   label: 'filepath' },
  regex:       { bar: 'bg-orange-400', badge: 'bg-orange-500/15 text-orange-400', label: 'regex' },
  convergence: { bar: 'bg-purple-400', badge: 'bg-purple-500/15 text-purple-400', label: 'convergence' },
};

const DEFAULT_SIGNAL_COLOR = { bar: 'bg-gray-400', badge: 'bg-gray-500/15 text-gray-400', label: 'score' };

const DIR_BAR_COLOR = 'bg-purple-400';

// ── Component ─────────────────────────────────────────────────────────────────

type ViewMode = 'file' | 'directory';

export default function SearchView() {
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [selectedSilo, setSelectedSilo] = useState(() => searchParams.get('silo') ?? 'all');
  const [silos, setSilos] = useState<SiloStatus[]>([]);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [directoryResults, setDirectoryResults] = useState<DirectoryResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [expandedResults, setExpandedResults] = useState<Set<number>>(new Set());
  const [searchMode, setSearchMode] = useState<ViewMode>('file');
  const [fileSearchMode, setFileSearchMode] = useState<SearchMode>('hybrid');
  const [startPath, setStartPath] = useState('');
  const [depthSetting, setDepthSetting] = useState(2);

  useEffect(() => {
    const fetch = () => window.electronAPI?.getSilos().then(setSilos);
    fetch();
    const unsub = window.electronAPI?.onSilosChanged(fetch);
    return () => unsub?.();
  }, []);

  const siloColorMap = useMemo(() => {
    const map = new Map<string, SiloColor>();
    for (const s of silos) map.set(s.config.name, s.config.color);
    return map;
  }, [silos]);

  const runSearch = useCallback(async (q: string, silo: string | undefined, sp?: string, mode?: SearchMode) => {
    if (!q.trim()) return;
    setHasSearched(true);
    setSearching(true);
    setExpandedResults(new Set());
    try {
      const res = await window.electronAPI?.search({
        query: q,
        startPath: sp || undefined,
        mode: mode ?? 'hybrid',
      }, silo || undefined) ?? [];
      setResults(res);
      setDirectoryResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const runExplore = useCallback(async (q: string, silo: string | undefined, sp?: string, depth?: number) => {
    setHasSearched(true);
    setSearching(true);
    setExpandedResults(new Set());
    try {
      const params: ExploreParams = {
        query: q.trim() || undefined,
        silo,
        startPath: sp || undefined,
        maxDepth: depth ?? 2,
      };
      const res = await window.electronAPI?.explore(params) ?? [];
      setDirectoryResults(res);
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  async function handleSearch() {
    if (searchMode === 'file' && !query.trim()) return;
    if (searching) return;
    const silo = selectedSilo === 'all' ? undefined : selectedSilo;
    if (searchMode === 'directory') {
      await runExplore(query, silo, startPath, depthSetting);
    } else {
      await runSearch(query, silo, startPath, fileSearchMode);
    }
  }

  function handleModeChange(mode: ViewMode) {
    setSearchMode(mode);
    setHasSearched(false);
    setResults([]);
    setDirectoryResults([]);
    setExpandedResults(new Set());
  }

  function toggleExpand(index: number) {
    setExpandedResults((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  const isDirectoryMode = searchMode === 'directory';

  return (
    <div>
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-background px-6 pt-6 pb-4">
        <div className="mb-4">
          <h1 className="text-lg font-semibold text-foreground">Search</h1>
        </div>

        {/* Search controls */}
        <div className="flex gap-3">
          <select
            value={selectedSilo}
            onChange={(e) => setSelectedSilo(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All Silos</option>
            {silos.map((s) => (
              <option key={s.config.name} value={s.config.name} disabled={s.watcherState === 'stopped'}>
                {s.config.name}{s.watcherState === 'stopped' ? ' (stopped)' : ''}
              </option>
            ))}
          </select>

          {/* Mode toggle */}
          <div className="flex rounded-md border border-input overflow-hidden">
            <button
              onClick={() => handleModeChange('file')}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors',
                searchMode === 'file'
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/30',
              )}
            >
              <FileText className="h-3.5 w-3.5" />
              Files
            </button>
            <button
              onClick={() => handleModeChange('directory')}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors border-l border-input',
                searchMode === 'directory'
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/30',
              )}
            >
              <Folder className="h-3.5 w-3.5" />
              Directories
            </button>
          </div>

          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder={isDirectoryMode ? 'Explore directory structure...' : 'Search your indexed files...'}
              className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        {/* Start path filter + depth (directory mode) + file search mode */}
        <div className="mt-2 flex items-center gap-2">
          {!isDirectoryMode && (
            <div className="flex rounded-md border border-input overflow-hidden shrink-0">
              {(['hybrid', 'semantic', 'bm25', 'filepath', 'regex'] as const).map((mode, i) => (
                <button
                  key={mode}
                  onClick={() => setFileSearchMode(mode)}
                  className={cn(
                    'px-2 py-1 text-[10px] transition-colors',
                    i > 0 && 'border-l border-input',
                    fileSearchMode === mode
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground/60 hover:bg-accent/30',
                  )}
                >
                  {mode}
                </button>
              ))}
            </div>
          )}
          <div className="relative flex-1">
            <input
              type="text"
              value={startPath}
              onChange={(e) => setStartPath(e.target.value)}
              placeholder="Filter to path (optional)"
              className="h-7 w-full rounded-md border border-input bg-background px-3 pr-7 text-xs text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {startPath && (
              <button
                onClick={() => setStartPath('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          {isDirectoryMode && (
            <>
              <span className="text-[10px] text-muted-foreground/50 shrink-0">depth</span>
              <input
                type="range"
                min={1}
                max={5}
                value={depthSetting}
                onChange={(e) => setDepthSetting(parseInt(e.target.value, 10))}
                className="w-16 h-1.5 accent-foreground shrink-0"
              />
              <span className="text-[10px] text-muted-foreground/50 w-3 shrink-0">{depthSetting}</span>
            </>
          )}
        </div>
      </div>

      {/* Results */}
      <div className="px-6 pb-6">
        {searching && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {isDirectoryMode ? 'Exploring...' : 'Searching...'}
          </div>
        )}

        {!searching && !hasSearched && (
          <p className="text-sm text-muted-foreground">
            {isDirectoryMode
              ? 'Enter a query and press Enter to explore directories, or press Enter with an empty query for a structural overview.'
              : 'Enter a query and press Enter to search.'}
          </p>
        )}

        {!searching && hasSearched && isDirectoryMode && (
          <DirectoryResultsView
            results={directoryResults}
            silos={silos}
            siloColorMap={siloColorMap}
            expandedResults={expandedResults}
            toggleExpand={toggleExpand}
          />
        )}

        {!searching && hasSearched && !isDirectoryMode && (
          <FileResultsView
            results={results}
            silos={silos}
            selectedSilo={selectedSilo}
            siloColorMap={siloColorMap}
            expandedResults={expandedResults}
            toggleExpand={toggleExpand}
          />
        )}
      </div>
    </div>
  );
}

// ── File Results View ────────────────────────────────────────────────────────

function FileResultsView({
  results,
  silos,
  selectedSilo,
  siloColorMap,
  expandedResults,
  toggleExpand,
}: {
  results: SearchResult[];
  silos: SiloStatus[];
  selectedSilo: string;
  siloColorMap: Map<string, SiloColor>;
  expandedResults: Set<number>;
  toggleExpand: (i: number) => void;
}) {
  const stoppedSilos = silos.filter((s) => s.watcherState === 'stopped');
  const stoppedSkipped = selectedSilo === 'all'
    ? stoppedSilos
    : stoppedSilos.filter((s) => s.config.name === selectedSilo);
  const stoppedHint = stoppedSkipped.length > 0
    ? `${stoppedSkipped.map((s) => s.config.name).join(', ')} ${stoppedSkipped.length === 1 ? 'is' : 'are'} stopped and ${stoppedSkipped.length === 1 ? 'was' : 'were'} not searched.`
    : null;

  if (results.length === 0) {
    return (
      <div>
        <p className="text-sm text-muted-foreground">No results found.</p>
        {stoppedHint && (
          <p className="mt-1 text-xs text-muted-foreground/50">{stoppedHint}</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="mb-3">
        <p className="text-xs text-muted-foreground">
          {results.length} result{results.length !== 1 && 's'}
        </p>
        {stoppedHint && (
          <p className="mt-0.5 text-[10px] text-muted-foreground/50">{stoppedHint}</p>
        )}
      </div>

      {results.map((result, i) => {
        const isExpanded = expandedResults.has(i);
        const sigColor = SIGNAL_COLORS[result.scoreLabel] ?? DEFAULT_SIGNAL_COLOR;

        return (
          <div key={`${result.filePath}-${i}`}>
            {/* Collapsed result row */}
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
                  <span className={cn(
                    'shrink-0 inline-flex items-center rounded px-1.5 py-0.5 text-[10px]',
                    sigColor.badge,
                  )}>
                    {sigColor.label}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground/50">
                  <span className="truncate">{dirPath(result.filePath)}</span>
                  <span className={cn(
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
                    (() => {
                      const c = siloColorMap.get(result.siloName) ?? DEFAULT_SILO_COLOR;
                      const classes = SILO_COLOR_MAP[c];
                      return `${classes.bgSoft} ${classes.text}`;
                    })(),
                  )}>
                    {result.siloName}
                  </span>
                </div>
              </div>

              {/* Score bar + percentage */}
              <div className="flex items-center gap-2 shrink-0">
                <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={cn('h-full rounded-full', sigColor.bar)}
                    style={{ width: `${Math.round(result.score * 100)}%` }}
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

            {/* Expanded view — signal breakdown + hint */}
            {isExpanded && (
              <div className="ml-[26px] border-l-2 border-accent/40 pl-4 pb-2">
                {/* Per-signal score bars */}
                <div className="mt-2 space-y-1">
                  {Object.entries(result.signals)
                    .sort(([, a], [, b]) => b - a)
                    .map(([name, score]) => {
                      const sc = SIGNAL_COLORS[name] ?? DEFAULT_SIGNAL_COLOR;
                      return (
                        <div key={name} className="flex items-center gap-2">
                          <span className="w-16 text-[10px] text-muted-foreground/60 text-right">{sc.label}</span>
                          <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
                            <div
                              className={cn('h-full rounded-full', sc.bar)}
                              style={{ width: `${Math.round(score * 100)}%` }}
                            />
                          </div>
                          <span className="w-8 text-[10px] text-muted-foreground/50 text-right">
                            {scorePercent(score)}
                          </span>
                        </div>
                      );
                    })}
                </div>

                {/* Hint — line range + section path */}
                {result.hint && result.hint.startLine != null && (
                  <div className="mt-2 text-xs text-muted-foreground/60">
                    Lines {result.hint.startLine}–{result.hint.endLine}
                    {result.hint.sectionPath && result.hint.sectionPath.length > 0 && (
                      <span className="ml-1.5 text-muted-foreground/40">
                        — {result.hint.sectionPath.join(' > ')}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Directory Results View ───────────────────────────────────────────────────

function DirectoryResultsView({
  results,
  silos,
  siloColorMap,
  expandedResults,
  toggleExpand,
}: {
  results: DirectoryResult[];
  silos: SiloStatus[];
  siloColorMap: Map<string, SiloColor>;
  expandedResults: Set<number>;
  toggleExpand: (i: number) => void;
}) {
  if (results.length === 0) {
    return <p className="text-sm text-muted-foreground">No directories found.</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="mb-3">
        <p className="text-xs text-muted-foreground">
          {results.length} director{results.length !== 1 ? 'ies' : 'y'}
        </p>
      </div>

      {results.map((result, i) => {
        const isExpanded = expandedResults.has(i);

        return (
          <div key={`${result.dirPath}-${i}`}>
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

              <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">
                    {result.dirName}/
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground/50">
                  <span className="truncate">{result.dirPath}</span>
                  <span className={cn(
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
                    (() => {
                      const c = siloColorMap.get(result.siloName) ?? DEFAULT_SILO_COLOR;
                      const classes = SILO_COLOR_MAP[c];
                      return `${classes.bgSoft} ${classes.text}`;
                    })(),
                  )}>
                    {result.siloName}
                  </span>
                  <span className="text-[10px] text-muted-foreground/40">
                    {result.fileCount} file{result.fileCount !== 1 ? 's' : ''} · {result.subdirCount} dir{result.subdirCount !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={cn('h-full rounded-full', DIR_BAR_COLOR)}
                    style={{ width: `${Math.round(result.score * 100)}%` }}
                  />
                </div>
                <span className="w-8 text-right text-xs text-muted-foreground">
                  {scorePercent(result.score)}
                </span>
              </div>
            </button>

            {/* Expanded: score breakdown + tree */}
            {isExpanded && (
              <div className="ml-[26px] border-l-2 border-accent/20 pl-4 pb-2 mt-1">
                {result.children.length > 0 && (
                  <DirectoryTree nodes={result.children} />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Directory Tree ───────────────────────────────────────────────────────────

function DirectoryTree({ nodes }: { nodes: DirectoryTreeNode[] }) {
  return (
    <div className="space-y-0.5">
      {nodes.map((node, i) => (
        <DirectoryTreeNodeRow key={node.path} node={node} isLast={i === nodes.length - 1} />
      ))}
    </div>
  );
}

function DirectoryTreeNodeRow({ node, isLast }: { node: DirectoryTreeNode; isLast: boolean }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 py-0.5">
        <Folder className="h-3 w-3 shrink-0 text-muted-foreground/50" />
        <span className="text-xs text-muted-foreground">{node.name}/</span>
        <span className="text-[10px] text-muted-foreground/30">
          {node.fileCount} file{node.fileCount !== 1 ? 's' : ''} · {node.subdirCount} dir{node.subdirCount !== 1 ? 's' : ''}
        </span>
      </div>
      {node.children.length > 0 && (
        <div className="ml-4 border-l border-accent/20 pl-3">
          <DirectoryTree nodes={node.children} />
        </div>
      )}
    </div>
  );
}

