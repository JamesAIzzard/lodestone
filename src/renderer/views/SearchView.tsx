import { useState } from 'react';
import { Search, FileText, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { mockSilos, mockSearchResults } from '../../shared/mock-data';
import type { SearchResult } from '../../shared/types';

function fileName(path: string): string {
  return path.split('/').pop() ?? path;
}

function dirPath(path: string): string {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/').replace(/^\/home\/[^/]+/, '~');
}

function scorePercent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function handleOpenFile(filePath: string) {
  window.electronAPI?.openPath(filePath);
}

export default function SearchView() {
  const [query, setQuery] = useState('');
  const [selectedSilo, setSelectedSilo] = useState('all');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);

  function handleSearch() {
    if (!query.trim()) return;
    setHasSearched(true);
    const filtered =
      selectedSilo === 'all'
        ? mockSearchResults
        : mockSearchResults.filter((r) => r.siloName === selectedSilo);
    setResults(filtered);
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
          {mockSilos.map((s) => (
            <option key={s.config.name} value={s.config.name}>
              {s.config.name}
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
        {!hasSearched && (
          <p className="text-sm text-muted-foreground">
            Enter a query and press Enter to search.
          </p>
        )}

        {hasSearched && results.length === 0 && (
          <p className="text-sm text-muted-foreground">No results found.</p>
        )}

        {results.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="mb-3 text-xs text-muted-foreground">
              {results.length} result{results.length !== 1 && 's'}
            </p>

            {results.map((result, i) => (
              <button
                key={`${result.filePath}-${i}`}
                onClick={() => handleOpenFile(result.filePath)}
                className={cn(
                  'group flex items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors',
                  'hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                )}
              >
                {/* Icon */}
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />

                {/* File info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {fileName(result.filePath)}
                    </span>
                    {result.matchingSection && (
                      <span className="shrink-0 text-xs text-muted-foreground/60">
                        — {result.matchingSection}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground/50">
                    <span className="truncate">{dirPath(result.filePath)}</span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {result.siloName}
                    </span>
                  </div>
                </div>

                {/* Score */}
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

                {/* Open icon */}
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground/30 opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
