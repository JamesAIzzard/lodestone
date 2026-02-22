import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Search, FileText, ExternalLink, Loader2, ChevronRight, ChevronDown, SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SILO_COLOR_MAP, DEFAULT_SILO_COLOR, type SiloColor } from '../../shared/silo-appearance';
import type { SiloStatus, SearchResult, MatchType, SearchWeights, ScoreBreakdown } from '../../shared/types';
import { DEFAULT_SEARCH_WEIGHTS, SEARCH_PRESETS } from '../../shared/types';

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

// ── Signal badge colours ───────────────────────────────────────────────────

const SIGNAL_COLORS = {
  semantic: 'bg-blue-500/15 text-blue-400',
  bm25:     'bg-amber-500/15 text-amber-400',
  trigram:  'bg-purple-500/15 text-purple-400',
  filepath: 'bg-cyan-500/15 text-cyan-400',
  tags:     'bg-pink-500/15 text-pink-400',
} as const;

const SIGNAL_BAR_COLORS = {
  semantic: 'bg-blue-400',
  bm25:     'bg-amber-400',
  trigram:  'bg-purple-400',
  filepath: 'bg-cyan-400',
  tags:     'bg-pink-400',
} as const;

const SIGNAL_LABELS = {
  semantic: 'semantic',
  bm25:     'keyword',
  trigram:  'substring',
  filepath: 'filepath',
  tags:     'tags',
} as const;

type SignalKey = keyof typeof SIGNAL_LABELS;

const SIGNAL_KEYS: SignalKey[] = ['semantic', 'bm25', 'trigram', 'filepath', 'tags'];

// Determine which signals contributed to a chunk's score
function activeSignals(breakdown: ScoreBreakdown): SignalKey[] {
  return SIGNAL_KEYS.filter((k) => (breakdown[k]?.rank ?? 0) > 0);
}

// ── Weight presets ─────────────────────────────────────────────────────────

const WEIGHT_PRESETS: Array<{ label: string; weights: SearchWeights }> = [
  { label: 'Balanced', weights: SEARCH_PRESETS.balanced },
  { label: 'Semantic', weights: SEARCH_PRESETS.semantic },
  { label: 'Keyword',  weights: SEARCH_PRESETS.keyword },
  { label: 'Code',     weights: SEARCH_PRESETS.code },
];

// Convert normalised [0,1] weights to integer slider values (0–100)
function weightsToSliders(w: SearchWeights): Record<SignalKey, number> {
  return {
    semantic: Math.round(w.semantic * 100),
    bm25:     Math.round(w.bm25 * 100),
    trigram:  Math.round(w.trigram * 100),
    filepath: Math.round(w.filepath * 100),
    tags:     Math.round(w.tags * 100),
  };
}

// Normalise raw slider values (0–100) to weights that sum to 1.0
function slidersToWeights(sliders: Record<SignalKey, number>): SearchWeights {
  const total = SIGNAL_KEYS.reduce((s, k) => s + sliders[k], 0);
  if (total === 0) return DEFAULT_SEARCH_WEIGHTS;
  return {
    semantic: sliders.semantic / total,
    bm25:     sliders.bm25 / total,
    trigram:  sliders.trigram / total,
    filepath: sliders.filepath / total,
    tags:     sliders.tags / total,
  };
}

export default function SearchView() {
  const [query, setQuery] = useState('');
  const [selectedSilo, setSelectedSilo] = useState('all');
  const [silos, setSilos] = useState<SiloStatus[]>([]);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [expandedResults, setExpandedResults] = useState<Set<number>>(new Set());
  const [tuningOpen, setTuningOpen] = useState(false);

  // Raw slider values (integers 0–100), kept in sync with config
  const [sliders, setSliders] = useState<Record<SignalKey, number>>(weightsToSliders(DEFAULT_SEARCH_WEIGHTS));

  // Debounce save timer ref
  const savePendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Debounce re-search timer ref
  const researchPendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const fetch = () => window.electronAPI?.getSilos().then(setSilos);
    fetch();
    const unsub = window.electronAPI?.onSilosChanged(fetch);
    return () => unsub?.();
  }, []);

  // Load weights from config on mount
  useEffect(() => {
    window.electronAPI?.getSearchWeights().then((w) => {
      if (w) setSliders(weightsToSliders(w));
    });
  }, []);

  // Build silo name → colour lookup
  const siloColorMap = useMemo(() => {
    const map = new Map<string, SiloColor>();
    for (const s of silos) map.set(s.config.name, s.config.color);
    return map;
  }, [silos]);

  const effectiveWeights = useMemo(() => slidersToWeights(sliders), [sliders]);

  const runSearch = useCallback(async (q: string, silo: string | undefined, w: SearchWeights) => {
    if (!q.trim()) return;
    setHasSearched(true);
    setSearching(true);
    setExpandedResults(new Set());
    try {
      const res = await window.electronAPI?.search(q, silo, w) ?? [];
      setResults(res);
    } finally {
      setSearching(false);
    }
  }, []);

  async function handleSearch() {
    if (!query.trim() || searching) return;
    const silo = selectedSilo === 'all' ? undefined : selectedSilo;
    await runSearch(query, silo, effectiveWeights);
  }

  function handleSliderChange(key: SignalKey, value: number) {
    const next = { ...sliders, [key]: value };
    setSliders(next);

    // Debounce save to config
    if (savePendingRef.current) clearTimeout(savePendingRef.current);
    savePendingRef.current = setTimeout(() => {
      window.electronAPI?.updateSearchWeights(slidersToWeights(next));
    }, 600);

    // Debounce re-search if there are existing results
    if (hasSearched && query.trim()) {
      if (researchPendingRef.current) clearTimeout(researchPendingRef.current);
      researchPendingRef.current = setTimeout(() => {
        const silo = selectedSilo === 'all' ? undefined : selectedSilo;
        runSearch(query, silo, slidersToWeights(next));
      }, 300);
    }
  }

  function applyPreset(preset: SearchWeights) {
    const next = weightsToSliders(preset);
    setSliders(next);
    window.electronAPI?.updateSearchWeights(preset);
    if (hasSearched && query.trim()) {
      const silo = selectedSilo === 'all' ? undefined : selectedSilo;
      runSearch(query, silo, preset);
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
    <div>
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-background px-6 pt-6 pb-4">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-foreground">Search</h1>
          <button
            onClick={() => setTuningOpen((o) => !o)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors',
              tuningOpen
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Tuning
          </button>
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

        {/* Tuning panel */}
        {tuningOpen && (
          <div className="mt-3 rounded-md border border-border bg-card p-4">
            <div className="mb-3 flex flex-wrap gap-1.5">
              {WEIGHT_PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => applyPreset(p.weights)}
                  className="rounded px-2.5 py-1 text-xs text-muted-foreground border border-border hover:bg-accent/50 hover:text-foreground transition-colors"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="space-y-2.5">
              {SIGNAL_KEYS.map((key) => (
                <div key={key} className="flex items-center gap-3">
                  <span className={cn('shrink-0 w-18 rounded px-1.5 py-0.5 text-[10px]', SIGNAL_COLORS[key])}>
                    {SIGNAL_LABELS[key]}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={sliders[key]}
                    onChange={(e) => handleSliderChange(key, parseInt(e.target.value, 10))}
                    className="flex-1 h-1.5 accent-foreground"
                  />
                  <span className="shrink-0 w-7 text-right text-[10px] text-muted-foreground">
                    {sliders[key]}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Results */}
      <div className="px-6 pb-6">
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
          const stoppedSilos = silos.filter((s) => s.watcherState === 'stopped');
          const stoppedSkipped = selectedSilo === 'all'
            ? stoppedSilos
            : stoppedSilos.filter((s) => s.config.name === selectedSilo);
          const stoppedHint = stoppedSkipped.length > 0
            ? `${stoppedSkipped.map((s) => s.config.name).join(', ')} ${stoppedSkipped.length === 1 ? 'is' : 'are'} stopped and ${stoppedSkipped.length === 1 ? 'was' : 'were'} not searched.`
            : null;

          return results.length === 0 ? (
            <div>
              <p className="text-sm text-muted-foreground">No results found.</p>
              {stoppedHint && (
                <p className="mt-1 text-xs text-muted-foreground/50">{stoppedHint}</p>
              )}
            </div>
          ) : (
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
                const signals = activeSignals(result.breakdown);

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
                          {/* Per-signal contribution badges */}
                          {signals.map((sig) => (
                            <span key={sig} className={cn('shrink-0 rounded px-1 py-0.5 text-[9px]', SIGNAL_COLORS[sig])}>
                              {SIGNAL_LABELS[sig]}
                            </span>
                          ))}
                        </div>
                      </div>

                      {/* Score bar */}
                      <div className="flex items-center gap-2 shrink-0">
                        <ScoreBar breakdown={result.breakdown} />
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
                        {/* File-level score info */}
                        <div className="mt-1.5 mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground/40">
                          <span>RRF {scorePercent(result.rrfScore)}</span>
                          <span>·</span>
                          <span>best cosine {scorePercent(result.bestCosineSimilarity)}</span>
                          {Math.abs(result.score - result.rrfScore) > 0.001 && (
                            <>
                              <span>·</span>
                              <span>calibrated {scorePercent(result.score)}</span>
                            </>
                          )}
                        </div>

                        {result.chunks.map((chunk, ci) => (
                          <div
                            key={ci}
                            className="mt-2 rounded-md bg-muted/30 px-3 py-2"
                          >
                            <div className="flex items-start justify-between gap-2 mb-1">
                              <div className="flex flex-wrap items-center gap-1 min-w-0">
                                {chunk.sectionPath.length > 0 && (
                                  <span className="text-[11px] font-medium text-muted-foreground">
                                    {chunk.sectionPath.join(' > ')}
                                  </span>
                                )}
                                {/* Per-signal badges for chunk */}
                                {activeSignals(chunk.breakdown).map((sig) => (
                                  <span key={sig} className={cn('rounded px-1 py-0.5 text-[9px]', SIGNAL_COLORS[sig])}>
                                    {SIGNAL_LABELS[sig]}
                                  </span>
                                ))}
                                {chunk.cosineSimilarity > 0 && (
                                  <span className="text-[10px] text-muted-foreground/40">
                                    cos {scorePercent(chunk.cosineSimilarity)}
                                  </span>
                                )}
                              </div>
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

// ── ScoreBar ─────────────────────────────────────────────────────────────────

/**
 * Segmented bar showing relative contribution of each signal to the RRF score.
 */
function ScoreBar({ breakdown }: { breakdown: ScoreBreakdown }) {
  const total = SIGNAL_KEYS.reduce((s, k) => s + (breakdown[k]?.rrfContribution ?? 0), 0);
  if (total === 0) {
    return <div className="w-16 h-1.5 rounded-full bg-muted/50" />;
  }

  return (
    <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden flex">
      {SIGNAL_KEYS.map((key) => {
        const contrib = breakdown[key]?.rrfContribution ?? 0;
        if (contrib <= 0) return null;
        const pct = (contrib / total) * 100;
        return (
          <div
            key={key}
            className={SIGNAL_BAR_COLORS[key]}
            style={{ width: `${pct}%` }}
          />
        );
      })}
    </div>
  );
}
